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

const roomUsers = {}; // roomId -> [{ socketId, clientId, username, role }]
const rateLimiter = {};
const usernameRegex = /^[a-zA-Z0-9_ -]{1,20}$/;
const roomRegex = /^[a-zA-Z0-9_-]{1,20}$/;
const clientIdRegex = /^[a-zA-Z0-9_-]{8,100}$/;
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
                blocked_at TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (room_code, client_id)
            )
        `);
        console.log("room_blocks table ready");
    } catch (err) {
        dbConnected = false;
        console.error("Database unavailable:", err.message);
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
            socket.emit("join-failure", "Invalid Room ID."); return;
        }
        if (!usernameRegex.test(username)) {
            socket.emit("join-failure", "Invalid Username."); return;
        }
        if (!clientIdRegex.test(clientId)) {
            socket.emit("join-failure", "Invalid client ID."); return;
        }

        if (await isBlocked(roomId, clientId)) {
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

        const role = roomUsers[roomId].length === 0 ? "admin" : "member";
        const user = { socketId: socket.id, clientId, username, role };
        roomUsers[roomId].push(user);
        socket.join(roomId);
        socket.roomId = roomId;
        socket.username = username;
        socket.clientId = clientId;
        socket.role = role;

        socket.emit("join-success", { role, clientId });
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
        } catch (err) { console.error(err); }
    });

    socket.on("clear-chat", async () => {
        try {
            if (!socket.roomId || socket.role !== "admin") {
                socket.emit("admin-error", "Only the room admin can clear chat.");
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
        if (targetSocket) {
            targetSocket.emit("kicked", "You were kicked from this room by the admin.");
            targetSocket.disconnect(true);
        }
    });

    socket.on("admin-block", async (data) => {
        if (socket.role !== "admin" || !socket.roomId) return;
        const target = findUser(socket.roomId, clean(data?.clientId));
        if (!target || target.clientId === socket.clientId || target.role === "admin") return;
        try {
            await pool.query(
                `INSERT INTO room_blocks (room_code, client_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [socket.roomId, target.clientId]
            );
            const targetSocket = io.sockets.sockets.get(target.socketId);
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
                "SELECT client_id FROM room_blocks WHERE room_code = $1 ORDER BY blocked_at DESC",
                [socket.roomId]
            );
            socket.emit("blocked-list", result.rows.map(r => r.client_id));
        } catch (err) {
            socket.emit("admin-error", "Could not load blocked users.");
        }
    });

    socket.on("disconnect", () => {
        const roomId = socket.roomId;
        if (rateLimiter[socket.id]) delete rateLimiter[socket.id];
        if (!roomId || !roomUsers[roomId]) return;

        socket.to(roomId).emit("typing", { username: socket.username, isTyping: false });
        const index = roomUsers[roomId].findIndex(u => u.socketId === socket.id);
        if (index === -1) return;
        const wasAdmin = roomUsers[roomId][index].role === "admin";
        const username = roomUsers[roomId][index].username;
        roomUsers[roomId].splice(index, 1);

        if (roomUsers[roomId].length === 0) {
            delete roomUsers[roomId];
        } else {
            if (wasAdmin) roomUsers[roomId][0].role = "admin";
            broadcastRoomState(roomId);
            socket.to(roomId).emit("system-message", `${username} left`);
        }
        console.log(`${username} disconnected from ${roomId}`);
    });
});

app.use((req, res) => res.status(404).send("404 - Page Not Found"));

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log(`IPChat running on port ${PORT}`));
