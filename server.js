require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");

const app = express();
app.disable("x-powered-by");
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static("public", { maxAge: "1d" }));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000
});

// roomId -> [{ socketId, clientId, username, role }]
const roomUsers = {};
const emptyRoomTimers = {};
const rateLimiter = {};

const usernameRegex = /^[a-zA-Z0-9_ -]{1,20}$/;
const roomRegex = /^[a-zA-Z0-9_-]{1,20}$/;
const clientIdRegex = /^[a-zA-Z0-9_-]{8,100}$/;

const EMPTY_ROOM_CLEAR_MS = 1 * 60 * 1000;
let dbConnected = false;

async function initDatabase() {
    try {
        await pool.query("SELECT 1");
        dbConnected = true;
        console.log("Database connected");

        await pool.query(`
            CREATE TABLE IF NOT EXISTS room_blocks (
                room_code TEXT NOT NULL,
                client_id TEXT NOT NULL,
                username TEXT,
                blocked_at TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (room_code, client_id)
            )
        `);

        // Keep existing installations compatible with the original table.
        await pool.query(`ALTER TABLE room_blocks ADD COLUMN IF NOT EXISTS username TEXT`);

        // Permanent room ownership. The owner is identified by the
        // anonymous clientId stored in that browser's localStorage.
        await pool.query(`
            CREATE TABLE IF NOT EXISTS room_owners (
                room_code TEXT PRIMARY KEY,
                owner_client_id TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                empty_since TIMESTAMPTZ
            )
        `);

        console.log("room_blocks and room_owners tables ready");
        await clearExpiredEmptyRooms();
    } catch (err) {
        dbConnected = false;
        console.error("Database unavailable:", err.message);
    }
}

async function clearExpiredEmptyRooms() {
    if (!dbConnected) return;

    try {
        const result = await pool.query(`
            SELECT room_code
            FROM room_owners
            WHERE empty_since IS NOT NULL
              AND empty_since <= NOW() - INTERVAL '1 minute'
        `);

        for (const row of result.rows) {
            await pool.query("DELETE FROM messages WHERE room_code = $1", [row.room_code]);
            await pool.query("DELETE FROM room_blocks WHERE room_code = $1", [row.room_code]);
            await pool.query("DELETE FROM room_owners WHERE room_code = $1", [row.room_code]);
            console.log(`Automatically cleared room data for room ${row.room_code}`);
        }
    } catch (err) {
        console.error("Expired room cleanup failed:", err.message);
    }
}

initDatabase();

function clean(value) {
    return typeof value === "string" ? value.trim() : "";
}

async function isBlocked(roomId, clientId) {
    if (!dbConnected) return false;

    try {
        const result = await pool.query(
            "SELECT 1 FROM room_blocks WHERE room_code = $1 AND client_id = $2 LIMIT 1",
            [roomId, clientId]
        );
        return result.rowCount > 0;
    } catch (err) {
        console.error("Block check failed:", err.message);
        return false;
    }
}

async function getRoomOwner(roomId) {
    if (!dbConnected) return null;

    try {
        const result = await pool.query(
            "SELECT owner_client_id FROM room_owners WHERE room_code = $1",
            [roomId]
        );
        return result.rows[0]?.owner_client_id || null;
    } catch (err) {
        console.error("Room owner lookup failed:", err.message);
        return null;
    }
}

async function ensureRoomOwner(roomId, clientId) {
    if (!dbConnected) return null;

    try {
        // Only the first client ever entering this room becomes its owner.
        // Later joins can never replace the owner.
        await pool.query(
            `INSERT INTO room_owners (room_code, owner_client_id)
             VALUES ($1, $2)
             ON CONFLICT (room_code) DO NOTHING`,
            [roomId, clientId]
        );

        return await getRoomOwner(roomId);
    } catch (err) {
        console.error("Room owner creation failed:", err.message);
        return null;
    }
}

async function markRoomActive(roomId) {
    if (!dbConnected) return;
    try {
        await pool.query(
            "UPDATE room_owners SET empty_since = NULL WHERE room_code = $1",
            [roomId]
        );
    } catch (err) {
        console.error("Could not mark room active:", err.message);
    }
}

async function markRoomEmpty(roomId) {
    if (!dbConnected) return;

    try {
        await pool.query(
            "UPDATE room_owners SET empty_since = NOW() WHERE room_code = $1",
            [roomId]
        );
    } catch (err) {
        console.error("Could not mark room empty:", err.message);
    }
}

function cancelEmptyRoomTimer(roomId) {
    if (emptyRoomTimers[roomId]) {
        clearTimeout(emptyRoomTimers[roomId]);
        delete emptyRoomTimers[roomId];
    }
}

function scheduleEmptyRoomClear(roomId) {
    cancelEmptyRoomTimer(roomId);

    emptyRoomTimers[roomId] = setTimeout(async () => {
        delete emptyRoomTimers[roomId];

        // Someone may have rejoined during the one-minute window.
        if (roomUsers[roomId]?.length) return;

        try {
            if (dbConnected) {
                const result = await pool.query(
                    `SELECT empty_since FROM room_owners WHERE room_code = $1`,
                    [roomId]
                );

                const emptySince = result.rows[0]?.empty_since;
                if (!emptySince) return;

                const elapsed = Date.now() - new Date(emptySince).getTime();
                if (elapsed < EMPTY_ROOM_CLEAR_MS) {
                    scheduleEmptyRoomClear(roomId);
                    return;
                }

                await pool.query("DELETE FROM messages WHERE room_code = $1", [roomId]);
                await pool.query("DELETE FROM room_blocks WHERE room_code = $1", [roomId]);
                await pool.query("DELETE FROM room_owners WHERE room_code = $1", [roomId]);

                console.log(`Automatically cleared room data for room ${roomId} after 1 minute empty`);
            }
        } catch (err) {
            console.error("Automatic chat clear failed:", err.message);
        }
    }, EMPTY_ROOM_CLEAR_MS);
}

function getRoomUsers(roomId) {
    return (roomUsers[roomId] || []).map(u => ({
        clientId: u.clientId,
        username: u.username,
        role: u.role
    }));
}

function broadcastRoomState(roomId) {
    const users = getRoomUsers(roomId);
    io.to(roomId).emit("room-state", {
        users,
        adminClientId: users.find(u => u.role === "admin")?.clientId || null
    });
    io.to(roomId).emit("user-list", users.map(u => u.username));
}

function findUser(roomId, clientId) {
    return (roomUsers[roomId] || []).find(u => u.clientId === clientId);
}

app.get("/messages/:room", async (req, res) => {
    try {
        const room = req.params.room;
        if (!roomRegex.test(room)) return res.status(400).json([]);

        const result = await pool.query(
            `SELECT * FROM messages WHERE room_code = $1 ORDER BY created_at ASC`,
            [room]
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Database query failed:", err.message);
        res.json([]);
    }
});

app.get("/", (req, res) => res.send("IPChat running"));

io.on("connection", (socket) => {
    console.log("User connected", socket.id);

    socket.on("join-room", async (data) => {
        if (!data || !data.roomId || !data.username || !data.clientId) {
            socket.emit("join-failure", "Room ID, Username and client ID are required.");
            return;
        }

        const roomId = clean(data.roomId);
        const username = clean(data.username);
        const clientId = clean(data.clientId);

        if (!roomRegex.test(roomId)) {
            socket.emit("join-failure", "Invalid Room ID.");
            return;
        }
        if (!usernameRegex.test(username)) {
            socket.emit("join-failure", "Invalid Username.");
            return;
        }
        if (!clientIdRegex.test(clientId)) {
            socket.emit("join-failure", "Invalid client ID.");
            return;
        }

        if (await isBlocked(roomId, clientId)) {
            // Keep the blocked user's most recently used username up to date.
            // This also repairs older block records that were created before
            // usernames were stored separately from client IDs.
            if (dbConnected) {
                try {
                    await pool.query(
                        `UPDATE room_blocks
                         SET username = $3
                         WHERE room_code = $1 AND client_id = $2`,
                        [roomId, clientId, username]
                    );
                } catch (err) {
                    console.error("Could not update blocked username:", err.message);
                }
            }
            socket.emit("join-failure", "You are blocked from this room.");
            return;
        }

        if (!roomUsers[roomId]) roomUsers[roomId] = [];

        if (roomUsers[roomId].some(u => u.clientId === clientId)) {
            socket.emit("join-failure", "This browser is already connected to this room.");
            return;
        }
        if (roomUsers[roomId].some(u => u.username.toLowerCase() === username.toLowerCase())) {
            socket.emit("join-failure", "Username is already taken in this room.");
            return;
        }

        const ownerClientId = await ensureRoomOwner(roomId, clientId);
        if (!ownerClientId) {
            socket.emit("join-failure", "Could not determine the room creator. Please try again.");
            return;
        }

        // Joining cancels the five-minute empty-room countdown.
        cancelEmptyRoomTimer(roomId);
        await markRoomActive(roomId);

        // Admin is ALWAYS the original room creator.
        // If the creator reconnects while members are already inside,
        // everyone else remains a normal member.
        const isCreator = clientId === ownerClientId;
        const role = isCreator ? "admin" : "member";

        if (isCreator) {
            roomUsers[roomId].forEach(u => {
                u.role = "member";
            });
        }

        const user = { socketId: socket.id, clientId, username, role };
        roomUsers[roomId].push(user);

        socket.join(roomId);
        socket.roomId = roomId;
        socket.username = username;
        socket.clientId = clientId;
        socket.role = role;

        socket.emit("join-success", { role, clientId, ownerClientId });
        broadcastRoomState(roomId);
        socket.to(roomId).emit("system-message", `${username} joined`);
        console.log(`${username} joined ${roomId} as ${role}`);
    });

    socket.on("typing", (data) => {
        if (!socket.roomId || !socket.username) return;
        socket.to(socket.roomId).emit("typing", {
            username: socket.username,
            isTyping: !!data?.isTyping
        });
    });

    socket.on("send-message", async (data) => {
        try {
            if (!socket.roomId || !socket.username || !data?.message) return;

            const rawMessage = clean(data.message);
            if (!rawMessage) return;

            const now = Date.now();
            if (!rateLimiter[socket.id]) rateLimiter[socket.id] = [];
            rateLimiter[socket.id] = rateLimiter[socket.id].filter(t => now - t < 3000);

            if (rateLimiter[socket.id].length >= 5) {
                socket.emit("system-message", "You are sending messages too fast.");
                return;
            }

            rateLimiter[socket.id].push(now);
            const message = rawMessage.substring(0, 1000);

            io.to(socket.roomId).emit("receive-message", {
                sender: socket.username,
                message
            });

            try {
                await pool.query(
                    `INSERT INTO messages (room_code, sender, message) VALUES ($1, $2, $3)`,
                    [socket.roomId, socket.username, message]
                );
            } catch (dbErr) {
                console.error("Database insert failed:", dbErr.message);
            }
        } catch (err) {
            console.error(err);
        }
    });

    socket.on("clear-chat", async () => {
        try {
            if (!socket.roomId || socket.role !== "admin") {
                socket.emit("admin-error", "Only the room creator can clear chat.");
                return;
            }

            await pool.query("DELETE FROM messages WHERE room_code = $1", [socket.roomId]);
            io.to(socket.roomId).emit("chat-cleared");
        } catch (err) {
            console.error("Clear chat failed:", err.message);
            socket.emit("admin-error", "Could not clear chat.");
        }
    });

    socket.on("admin-kick", (data) => {
        if (socket.role !== "admin" || !socket.roomId) return;

        const target = findUser(socket.roomId, clean(data?.clientId));
        if (!target || target.clientId === socket.clientId || target.role === "admin") return;

        const targetSocket = io.sockets.sockets.get(target.socketId);

        // Remove the target from our room state BEFORE disconnecting the socket.
        // This prevents a fast rejoin from seeing "already connected" while
        // Socket.IO is still finishing the disconnect event.
        roomUsers[socket.roomId] = roomUsers[socket.roomId].filter(
            u => u.socketId !== target.socketId
        );
        broadcastRoomState(socket.roomId);
        socket.to(socket.roomId).emit("system-message", `${target.username} was kicked`);

        if (targetSocket) {
            targetSocket.emit("kicked", "You were kicked from this room by the admin.");
            targetSocket.disconnect(true);
        }
    });

    socket.on("admin-block", async (data) => {
        if (socket.role !== "admin" || !socket.roomId) return;

        const target = findUser(socket.roomId, clean(data?.clientId));
        if (!target || target.clientId === socket.clientId || target.role === "admin") return;

        const roomId = socket.roomId;
        const targetClientId = target.clientId;
        const targetUsername = target.username;
        const targetSocket = io.sockets.sockets.get(target.socketId);

        try {
            await pool.query(
                `INSERT INTO room_blocks (room_code, client_id, username)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (room_code, client_id)
                 DO UPDATE SET username = EXCLUDED.username, blocked_at = NOW()`,
                [roomId, targetClientId, targetUsername]
            );

            // Remove the target immediately so the room state and rejoin check
            // are updated before the client's disconnect finishes.
            roomUsers[roomId] = roomUsers[roomId].filter(
                u => u.socketId !== target.socketId
            );

            broadcastRoomState(roomId);
            io.to(roomId).emit("system-message", `${targetUsername} was blocked`);

            // Update the admin's blocked list immediately—no reload required.
            const result = await pool.query(
                `SELECT client_id AS "clientId", username
                 FROM room_blocks
                 WHERE room_code = $1
                 ORDER BY blocked_at DESC`,
                [roomId]
            );
            socket.emit("blocked-list", result.rows);

            if (targetSocket) {
                targetSocket.emit("blocked", "You were blocked from this room by the admin.");
                targetSocket.disconnect(true);
            }
        } catch (err) {
            console.error("Block failed:", err.message);
            socket.emit("admin-error", "Could not block that user.");
        }
    });

    socket.on("admin-unblock", async (data) => {
        if (socket.role !== "admin" || !socket.roomId) return;

        const clientId = clean(data?.clientId);
        if (!clientId) return;

        try {
            await pool.query(
                "DELETE FROM room_blocks WHERE room_code = $1 AND client_id = $2",
                [socket.roomId, clientId]
            );
            socket.emit("admin-info", "User unblocked. They can join this room again.");
        } catch (err) {
            console.error("Unblock failed:", err.message);
            socket.emit("admin-error", "Could not unblock that user.");
        }
    });

    socket.on("admin-get-blocks", async () => {
        if (socket.role !== "admin" || !socket.roomId) return;

        try {
            const result = await pool.query(
                `SELECT client_id AS "clientId", username
                 FROM room_blocks
                 WHERE room_code = $1
                 ORDER BY blocked_at DESC`,
                [socket.roomId]
            );
            socket.emit("blocked-list", result.rows);
        } catch (err) {
            socket.emit("admin-error", "Could not load blocked users.");
        }
    });

    socket.on("disconnect", async () => {
        const roomId = socket.roomId;
        if (rateLimiter[socket.id]) delete rateLimiter[socket.id];
        if (!roomId || !roomUsers[roomId]) return;

        socket.to(roomId).emit("typing", { username: socket.username, isTyping: false });

        const index = roomUsers[roomId].findIndex(u => u.socketId === socket.id);
        if (index === -1) return;

        const username = roomUsers[roomId][index].username;
        const clientId = roomUsers[roomId][index].clientId;
        roomUsers[roomId].splice(index, 1);

        // IMPORTANT: never transfer admin to another user.
        // The original room creator remains the only admin.
        if (roomUsers[roomId].length === 0) {
            delete roomUsers[roomId];
            await markRoomEmpty(roomId);
            scheduleEmptyRoomClear(roomId);
        } else {
            broadcastRoomState(roomId);
            socket.to(roomId).emit("system-message", `${username} left`);
        }

        console.log(`${username} (${clientId}) disconnected from ${roomId}`);
    });
});

app.use((req, res) => res.status(404).send("404 - Page Not Found"));

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`IPChat running on port ${PORT}`));
