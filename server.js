const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
const { Server } = require("socket.io");
const Database = require("better-sqlite3");

const app = express();
const server = http.createServer(app);

const ALLOWED_ORIGINS = [
    "https://homeworkstudyh.netlify.app",
    "https://gamehub-t22r.onrender.com"
];

const io = new Server(server, {
    cors: {
        origin: ALLOWED_ORIGINS,
        methods: ["GET", "POST"],
        credentials: true
    }
});

app.use(cors({
    origin: ALLOWED_ORIGINS,
    credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* =========================
   DATABASE
========================= */

const db = new Database("gamehub.db");

db.pragma("journal_mode = WAL");

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,
        receiver TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

/* =========================
   STATIC FILES
========================= */

app.use(express.static(__dirname));

app.get("/", (req, res) => {
    res.sendFile(
        path.join(__dirname, "Schoolgames.html")
    );
});

app.get("/manifest.webmanifest", (req, res) => {
    res.sendFile(
        path.join(__dirname, "manifest.webmanifest")
    );
});

app.get("/sw.js", (req, res) => {
    res.sendFile(
        path.join(__dirname, "sw.js")
    );
});

/* =========================
   USER API
========================= */

app.post("/api/register", (req, res) => {

    try {

        const username = String(req.body.username || "").trim();

        if (!username) {
            return res.status(400).json({
                error: "Username required"
            });
        }

        if (username.length > 24) {
            return res.status(400).json({
                error: "Username is too long"
            });
        }

        const existing = db
            .prepare("SELECT * FROM users WHERE username = ?")
            .get(username);

        if (existing) {
            return res.json({
                success: true,
                user: existing
            });
        }

        const result = db
            .prepare("INSERT INTO users (username) VALUES (?)")
            .run(username);

        const user = db
            .prepare("SELECT * FROM users WHERE id = ?")
            .get(result.lastInsertRowid);

        res.json({
            success: true,
            user
        });

    } catch (error) {

        console.error("Register error:", error);

        res.status(500).json({
            error: "Server error"
        });
    }
});

/* =========================
   GET USERS
========================= */

app.get("/api/users", (req, res) => {

    try {

        const users = db
            .prepare(`
                SELECT id, username, created_at
                FROM users
                ORDER BY username COLLATE NOCASE
            `)
            .all();

        res.json(users);

    } catch (error) {

        console.error("Users error:", error);

        res.status(500).json({
            error: "Server error"
        });
    }
});

/* =========================
   MESSAGES
========================= */

app.get("/api/messages", (req, res) => {

    try {

        const sender = String(req.query.sender || "");
        const receiver = String(req.query.receiver || "");

        if (!sender || !receiver) {
            return res.json([]);
        }

        const messages = db
            .prepare(`
                SELECT
                    id,
                    sender,
                    receiver,
                    message,
                    created_at
                FROM messages
                WHERE
                    (sender = ? AND receiver = ?)
                    OR
                    (sender = ? AND receiver = ?)
                ORDER BY id ASC
            `)
            .all(
                sender,
                receiver,
                receiver,
                sender
            );

        res.json(messages);

    } catch (error) {

        console.error("Messages error:", error);

        res.status(500).json({
            error: "Server error"
        });
    }
});

/* =========================
   ONLINE USERS
========================= */

const onlineUsers = new Map();

function broadcastOnlineUsers() {

    const users = Array.from(
        onlineUsers.values()
    );

    io.emit("online-users", users);
}

/* =========================
   SOCKET.IO
========================= */

io.on("connection", socket => {

    console.log("Socket connected:", socket.id);

    /* LOGIN */

    socket.on("login", username => {

        username = String(username || "").trim();

        if (!username) {
            return;
        }

        onlineUsers.set(socket.id, {
            id: socket.id,
            username
        });

        socket.username = username;

        console.log(
            `${username} is online`
        );

        socket.emit("login-success", {
            username,
            id: socket.id
        });

        broadcastOnlineUsers();
    });

    /* =========================
       CHAT
    ========================= */

    socket.on("send-message", data => {

        if (!data) {
            return;
        }

        const sender =
            socket.username ||
            String(data.sender || "").trim();

        const receiver =
            String(data.receiver || "").trim();

        const message =
            String(data.message || "").trim();

        if (!sender || !receiver || !message) {
            return;
        }

        db.prepare(`
            INSERT INTO messages
            (sender, receiver, message)
            VALUES (?, ?, ?)
        `).run(
            sender,
            receiver,
            message
        );

        let receiverSocket = null;

        for (const [socketId, user] of onlineUsers.entries()) {

            if (
                user.username.toLowerCase() ===
                receiver.toLowerCase()
            ) {

                receiverSocket = socketId;
                break;
            }
        }

        const messageData = {
            sender,
            receiver,
            message,
            created_at: new Date().toISOString()
        };

        socket.emit(
            "message-sent",
            messageData
        );

        if (receiverSocket) {

            io.to(receiverSocket).emit(
                "receive-message",
                messageData
            );
        }
    });

    /* =========================
       CALL REQUEST
    ========================= */

    socket.on("call-user", data => {

        if (!data) {
            return;
        }

        const receiver =
            String(data.receiver || "").trim();

        if (!receiver) {
            return;
        }

        let receiverSocket = null;

        for (const [socketId, user] of onlineUsers.entries()) {

            if (
                user.username.toLowerCase() ===
                receiver.toLowerCase()
            ) {

                receiverSocket = socketId;
                break;
            }
        }

        if (!receiverSocket) {

            socket.emit("call-error", {
                message: `${receiver} is not online.`
            });

            return;
        }

        io.to(receiverSocket).emit(
            "call-user",
            {
                caller: socket.username,
                callerId: socket.id,
                video: !!data.video
            }
        );
    });

    /* =========================
       CALL ACCEPTED
    ========================= */

    socket.on("call-accepted", data => {

        if (!data || !data.callerId) {
            return;
        }

        io.to(data.callerId).emit(
            "call-accepted",
            {
                receiverId: socket.id,
                receiver: socket.username
            }
        );
    });

    /* =========================
       CALL DECLINED
    ========================= */

    socket.on("call-declined", data => {

        if (!data || !data.callerId) {
            return;
        }

        io.to(data.callerId).emit(
            "call-declined",
            {
                receiverId: socket.id,
                receiver: socket.username
            }
        );
    });

    /* =========================
       WEBRTC OFFER
    ========================= */

    socket.on("webrtc-offer", data => {

        if (!data || !data.target) {
            return;
        }

        io.to(data.target).emit(
            "webrtc-offer",
            {
                offer: data.offer,
                sender: socket.id
            }
        );
    });

    /* =========================
       WEBRTC ANSWER
    ========================= */

    socket.on("webrtc-answer", data => {

        if (!data || !data.target) {
            return;
        }

        io.to(data.target).emit(
            "webrtc-answer",
            {
                answer: data.answer,
                sender: socket.id
            }
        );
    });

    /* =========================
       ICE CANDIDATES
    ========================= */

    socket.on("webrtc-ice", data => {

        if (!data || !data.target) {
            return;
        }

        io.to(data.target).emit(
            "webrtc-ice",
            {
                candidate: data.candidate,
                sender: socket.id
            }
        );
    });

    /* =========================
       END CALL
    ========================= */

    socket.on("end-call", data => {

        if (!data || !data.target) {
            return;
        }

        io.to(data.target).emit(
            "end-call",
            {
                sender: socket.id
            }
        );
    });

    /* =========================
       DISCONNECT
    ========================= */

    socket.on("disconnect", () => {

        const user =
            onlineUsers.get(socket.id);

        if (user) {

            console.log(
                `${user.username} disconnected`
            );

            onlineUsers.delete(
                socket.id
            );

            broadcastOnlineUsers();
        }
    });
});

/* =========================
   SERVER
========================= */

const PORT =
    process.env.PORT || 3002;

server.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log("");
        console.log("================================");
        console.log("       GAMEHUB SERVER ONLINE");
        console.log("================================");
        console.log("");
        console.log(`Port: ${PORT}`);
        console.log("");
        console.log(
            "Allowed GameHub:"
        );
        console.log(
            "https://homeworkstudyh.netlify.app"
        );
        console.log("");
        console.log(
            "Render:"
        );
        console.log(
            "https://gamehub-t22r.onrender.com"
        );
        console.log("");
    }
);
