// server.js

require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
app.disable("x-powered-by");

const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public", { maxAge: "1d" }));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

/*
 * Room structure:
 * roomUsers[roomId] = {
 *   adminId: "persistent client id",
 *   users: [{ id, username, socketId, role }],
 *   blocked: Set([clientId])
 * }
 */
const roomUsers = {};

const usernameRegex = /^[a-zA-Z0-9_ -]{1,20}$/;
const roomRegex = /^[a-zA-Z0-9_-]{1,20}$/;
const clientIdRegex = /^[a-f0-9-]{20,80}$/i;

function sanitizeInput(str) {
    if (typeof str !== "string") return "";
    return str;
}

const rateLimiter = {};
let dbConnected = false;

pool.connect()
    .then(() => {
        dbConnected = true;
        console.log("Database connected");
    })
    .catch((err) => {
        dbConnected = false;
        console.log("Database connection failed. Continuing in local-only mode. Error:", err.message);
    });

app.get("/messages/:room", async (req, res) => {
    try {
        if (!dbConnected) return res.json([]);

        const room = req.params.room;
        if (!roomRegex.test(room)) return res.status(400).json([]);

        const result = await pool.query(
            `SELECT * FROM messages
             WHERE room_code = $1
             ORDER BY created_at ASC`,
            [room]
        );

        res.json(result.rows);
    } catch (err) {
        console.error("Database query failed:", err.message);
        res.json([]);
    }
});

app.get("/", (req, res) => {
    res.send("IPChat running");
});

function getRoomUsers(roomId) {
    return roomUsers[roomId]?.users || [];
}

function publicUserList(roomId) {
    return getRoomUsers(roomId).map((user) => ({
        id: user.id,
        username: user.username,
        role: user.role
    }));
}

function broadcastUserList(roomId) {
    io.to(roomId).emit("user-list", publicUserList(roomId));
}

function findUser(roomId, userId) {
    return getRoomUsers(roomId).find((user) => user.id === userId);
}

function isAdmin(socket, roomId = socket.roomId) {
    return Boolean(
        roomId &&
        roomUsers[roomId] &&
        socket.clientUserId &&
        roomUsers[roomId].adminId === socket.clientUserId
    );
}

function emitAdminError(socket, message) {
    socket.emit("admin-error", message);
}

io.on("connection", (socket) => {
    console.log("User connected");

    socket.on("join-room", (data) => {
        if (!data || !data.roomId || !data.username || !data.clientId) {
            socket.emit("join-failure", "Room ID, Username and Client ID are required.");
            return;
        }

        const cleanRoomId = String(data.roomId).trim();
        const cleanUsername = String(data.username).trim();
        const cleanClientId = String(data.clientId).trim();

        if (!roomRegex.test(cleanRoomId)) {
            socket.emit("join-failure", "Room ID must be 1-20 characters (letters, numbers, underscores, dashes).");
            return;
        }

        if (!usernameRegex.test(cleanUsername)) {
            socket.emit("join-failure", "Username must be 1-20 characters (letters, numbers, spaces, underscores, dashes).");
            return;
        }

        if (!clientIdRegex.test(cleanClientId)) {
            socket.emit("join-failure", "Invalid client ID.");
            return;
        }

        if (!roomUsers[cleanRoomId]) {
            roomUsers[cleanRoomId] = {
                adminId: cleanClientId,
                users: [],
                blocked: new Map()
            };
        }

        const room = roomUsers[cleanRoomId];

        // A block applies to this room only.
        if (room.blocked.has(cleanClientId)) {
            socket.emit("join-failure", "You are blocked from this room.");
            return;
        }

        // Same client cannot have two active connections in the same room.
        if (room.users.some((u) => u.id === cleanClientId)) {
            socket.emit("join-failure", "You are already connected to this room.");
            return;
        }

        // Check duplicate username in this room.
        if (room.users.some((u) => u.username.toLowerCase() === cleanUsername.toLowerCase())) {
            socket.emit("join-failure", "Username is already taken in this room.");
            return;
        }

        const role = room.adminId === cleanClientId ? "admin" : "member";

        const user = {
            id: cleanClientId,
            username: cleanUsername,
            socketId: socket.id,
            role
        };

        room.users.push(user);

        socket.join(cleanRoomId);
        socket.roomId = cleanRoomId;
        socket.username = cleanUsername;
        socket.clientUserId = cleanClientId;
        socket.role = role;

        socket.emit("room-state", {
            role,
            userId: cleanClientId
        });

        if (role === "admin") {
            socket.emit("blocked-list", Array.from(room.blocked, ([id, username]) => ({ id, username })));
        }

        broadcastUserList(cleanRoomId);

        socket.to(cleanRoomId).emit("system-message", `${cleanUsername} joined`);
        console.log(`${cleanUsername} joined ${cleanRoomId} as ${role}`);
    });

    socket.on("typing", (data) => {
        if (!socket.roomId || !socket.username) return;

        socket.to(socket.roomId).emit("typing", {
            username: socket.username,
            isTyping: Boolean(data?.isTyping)
        });
    });

    socket.on("send-message", async (data) => {
        try {
            if (!socket.roomId || !socket.username) return;
            if (!data || typeof data.message !== "string") return;

            const rawMessage = data.message.trim();
            if (!rawMessage) return;

            const now = Date.now();
            if (!rateLimiter[socket.id]) rateLimiter[socket.id] = [];

            rateLimiter[socket.id] = rateLimiter[socket.id].filter((t) => now - t < 3000);

            if (rateLimiter[socket.id].length >= 5) {
                socket.emit("system-message", "You are sending messages too fast.");
                return;
            }

            rateLimiter[socket.id].push(now);

            const limitedMessage = rawMessage.substring(0, 1000);
            const sanitizedMessage = sanitizeInput(limitedMessage);
            const roomId = socket.roomId;
            const sender = socket.username;

            io.to(roomId).emit("receive-message", {
                sender,
                message: sanitizedMessage
            });

            if (dbConnected) {
                try {
                    await pool.query(
                        `INSERT INTO messages (room_code, sender, message)
                         VALUES ($1, $2, $3)`,
                        [roomId, sender, sanitizedMessage]
                    );
                } catch (dbErr) {
                    console.error("Database insert failed:", dbErr.message);
                }
            }
        } catch (err) {
            console.log(err);
        }
    });

    // ADMIN: kick a user. They may rejoin later.
    socket.on("kick-user", (data) => {
        const roomId = socket.roomId;
        const targetId = data?.userId;

        if (!isAdmin(socket)) {
            emitAdminError(socket, "Only the room admin can kick users.");
            return;
        }

        if (!targetId || targetId === socket.clientUserId) {
            emitAdminError(socket, "You cannot kick yourself.");
            return;
        }

        const target = findUser(roomId, targetId);
        if (!target) {
            emitAdminError(socket, "User is no longer in the room.");
            return;
        }

        const targetSocket = io.sockets.sockets.get(target.socketId);
        if (!targetSocket) return;

        targetSocket.emit("kicked", "You were kicked from this room by the admin.");
        targetSocket.disconnect(true);

        console.log(`[ADMIN] ${socket.username} kicked ${target.username} from ${roomId}`);
    });

    // ADMIN: block a user. The block lasts while this room exists.
    socket.on("block-user", (data) => {
        const roomId = socket.roomId;
        const targetId = data?.userId;

        if (!isAdmin(socket)) {
            emitAdminError(socket, "Only the room admin can block users.");
            return;
        }

        if (!targetId || targetId === socket.clientUserId) {
            emitAdminError(socket, "You cannot block yourself.");
            return;
        }

        const room = roomUsers[roomId];
        const target = findUser(roomId, targetId);

        if (!target) {
            emitAdminError(socket, "User is no longer in the room.");
            return;
        }

        room.blocked.set(target.id, target.username);

        const targetSocket = io.sockets.sockets.get(target.socketId);
        if (targetSocket) {
            targetSocket.emit("blocked", "You were blocked from this room by the admin.");
            targetSocket.disconnect(true);
        }

        socket.emit("blocked-list", Array.from(room.blocked, ([id, username]) => ({ id, username })));
        console.log(`[ADMIN] ${socket.username} blocked ${target.username} from ${roomId}`);
    });

    // ADMIN: unblock a previously blocked client ID.
    socket.on("unblock-user", (data) => {
        const roomId = socket.roomId;
        const targetId = data?.userId;

        if (!isAdmin(socket)) {
            emitAdminError(socket, "Only the room admin can unblock users.");
            return;
        }

        if (!targetId) {
            emitAdminError(socket, "Invalid user ID.");
            return;
        }

        const room = roomUsers[roomId];
        if (!room.blocked.has(targetId)) {
            emitAdminError(socket, "That user is not blocked.");
            return;
        }

        room.blocked.delete(targetId);
        socket.emit("blocked-list", Array.from(room.blocked, ([id, username]) => ({ id, username })));
        socket.emit("admin-notice", "User has been unblocked. They can join the room again.");
        console.log(`[ADMIN] ${socket.username} unblocked ${targetId} in ${roomId}`);
    });

    // ADMIN ONLY: clear chat.
    socket.on("clear-chat", async () => {
        try {
            const roomId = socket.roomId;
            if (!roomId || !isAdmin(socket)) {
                emitAdminError(socket, "Only the room admin can clear the chat.");
                return;
            }

            if (dbConnected) {
                try {
                    await pool.query("DELETE FROM messages WHERE room_code = $1", [roomId]);
                } catch (dbErr) {
                    console.error(`[Clear Chat Failed DB] ${roomId}`, dbErr.message);
                    socket.emit("system-message", "Failed to clear chat.");
                    return;
                }
            }

            io.to(roomId).emit("chat-cleared");
            console.log(`[ADMIN] ${socket.username} cleared chat in ${roomId}`);
        } catch (err) {
            console.log(err);
        }
    });

    socket.on("disconnect", () => {
        const roomId = socket.roomId;
        const username = socket.username;
        const clientUserId = socket.clientUserId;

        delete rateLimiter[socket.id];

        if (!roomId || !roomUsers[roomId]) {
            console.log("User disconnected");
            return;
        }

        const room = roomUsers[roomId];

        socket.to(roomId).emit("typing", {
            username,
            isTyping: false
        });

        room.users = room.users.filter((user) => user.socketId !== socket.id);

        // If the admin leaves, promote the first remaining user.
        if (room.adminId === clientUserId && room.users.length > 0) {
            const newAdmin = room.users[0];
            room.adminId = newAdmin.id;
            newAdmin.role = "admin";

            const newAdminSocket = io.sockets.sockets.get(newAdmin.socketId);
            if (newAdminSocket) {
                newAdminSocket.role = "admin";
                newAdminSocket.emit("room-state", {
                    role: "admin",
                    userId: newAdmin.id
                });
                newAdminSocket.emit("blocked-list", Array.from(room.blocked, ([id, username]) => ({ id, username })));
            }

            io.to(roomId).emit("system-message", `${newAdmin.username} is now the room admin`);
            console.log(`[ADMIN] ${newAdmin.username} promoted in ${roomId}`);
        }

        if (room.users.length > 0) {
            broadcastUserList(roomId);
            socket.to(roomId).emit("system-message", `${username} left`);
        } else {
            delete roomUsers[roomId];
            console.log(`[Room Cleanup] Memory cleaned for room: ${roomId}`);

            if (dbConnected) {
                pool.query("DELETE FROM messages WHERE room_code = $1", [roomId])
                    .then(() => console.log(`[Room Cleanup] Messages deleted for ${roomId}`))
                    .catch((dbErr) => console.error(`[Room Cleanup] DB cleanup failed for ${roomId}`, dbErr.message));
            }
        }

        console.log("User disconnected");
    });
});

app.use((req, res) => {
    res.status(404).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>404 - Page Not Found | IPChat</title>
            <link rel="stylesheet" href="/style.css">
        </head>
        <body>
            <div class="container error-container">
                <h1 class="error-code">404</h1>
                <h2>Page Not Found</h2>
                <p class="error-desc">The room or page you are looking for does not exist or has been moved.</p>
                <a href="/" class="home-btn">Return Home</a>
            </div>
        </body>
        </html>
    `);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`IPChat running on port ${PORT}`);
});
