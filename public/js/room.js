// public/js/room.js

document.addEventListener("DOMContentLoaded", () => {
    const socket = io();

    const params = new URLSearchParams(window.location.search);
    const roomId = params.get("room");
    const username = params.get("username") || "Anonymous";

    // Persistent anonymous identity for this browser. No registration is required.
    let clientId = localStorage.getItem("ipchat_client_id");
    if (!clientId) {
        clientId = crypto.randomUUID();
        localStorage.setItem("ipchat_client_id", clientId);
    }

    if (!roomId) {
        window.location.href = "/index.html?error=Room%20ID%20is%20required";
        return;
    }

    // Set page title dynamically
    document.title = `IPChat | Room ${roomId}`;
    document.getElementById("roomTitle").innerText = `Room ${roomId}`;

    // Elements
    const messages = document.getElementById("messages");
    const messageInput = document.getElementById("messageInput");
    const sendBtn = document.getElementById("sendBtn");
    const connectionStatus = document.getElementById("connectionStatus");
    const loadingOverlay = document.getElementById("loadingOverlay");

    // Collapsible Mobile Sidebar elements
    const toggleSidebarBtn = document.getElementById("toggleSidebarBtn");
    const sidebar = document.querySelector(".sidebar");
    const sidebarOverlay = document.getElementById("sidebarOverlay");

    if (toggleSidebarBtn && sidebar && sidebarOverlay) {
        toggleSidebarBtn.onclick = () => {
            sidebar.classList.toggle("open");
            sidebarOverlay.classList.toggle("show");
        };
        sidebarOverlay.onclick = () => {
            sidebar.classList.remove("open");
            sidebarOverlay.classList.remove("show");
        };
    }

    // State Variables
    let typingTimeout = null;
    let localIsTyping = false;
    let cooldownActive = false;
    let isInitialLoad = true;
    let isAdmin = false;
    let blockedUsers = [];

    // Join the room
    socket.emit("join-room", {
        roomId,
        username,
        clientId
    });

    // Connection Lifecycle
    socket.on("connect", () => {
        if (connectionStatus) {
            connectionStatus.classList.remove("show");
        }
        if (!cooldownActive && sendBtn) {
            sendBtn.disabled = false;
        }
        if (messageInput) {
            messageInput.disabled = false;
            messageInput.placeholder = "Type message...";
        }
    });

    socket.on("disconnect", () => {
        if (connectionStatus) {
            connectionStatus.innerText = "Reconnecting to server...";
            connectionStatus.classList.add("show");
        }
        if (sendBtn) {
            sendBtn.disabled = true;
        }
        if (messageInput) {
            messageInput.disabled = true;
            messageInput.placeholder = "Disconnected from server...";
        }
    });

    socket.on("join-failure", (errorMsg) => {
        // Redirect back to login screen with sanitization
        window.location.href = `/index.html?error=${encodeURIComponent(errorMsg)}`;
    });

    // 400ms Spam Cooldown Helper
    function triggerSendCooldown() {
        cooldownActive = true;
        if (sendBtn) {
            sendBtn.disabled = true;
        }
        setTimeout(() => {
            cooldownActive = false;
            if (socket.connected && sendBtn) {
                sendBtn.disabled = false;
            }
        }, 400); // 400ms cooldown
    }

    // Typing emission throttler
    function stopTyping() {
        if (localIsTyping) {
            localIsTyping = false;
            clearTimeout(typingTimeout);
            socket.emit("typing", {
                isTyping: false
            });
        }
    }

    if (messageInput) {
        messageInput.addEventListener("input", () => {
            if (!localIsTyping) {
                localIsTyping = true;
                socket.emit("typing", {
                    isTyping: true
                });
            }

            clearTimeout(typingTimeout);
            typingTimeout = setTimeout(() => {
                stopTyping();
            }, 2000);
        });
    }

    // Polished empty state rendering helper
    function showEmptyState() {
        if (!messages) return;
        
        const emptyDiv = document.createElement("div");
        emptyDiv.id = "emptyState";
        emptyDiv.classList.add("empty-state");

        const icon = document.createElement("div");
        icon.classList.add("empty-state-icon");
        icon.textContent = "💬";

        const title = document.createElement("div");
        title.classList.add("empty-state-title");
        title.textContent = "No messages yet";

        const subtitle = document.createElement("div");
        subtitle.classList.add("empty-state-subtitle");
        subtitle.textContent = "Be the first to start the conversation!";

        emptyDiv.appendChild(icon);
        emptyDiv.appendChild(title);
        emptyDiv.appendChild(subtitle);
        messages.appendChild(emptyDiv);
    }

    // Load History Messages
    async function loadMessages() {
        try {
            const res = await fetch(`/messages/${encodeURIComponent(roomId)}`);
            if (res.ok) {
                const data = await res.json();
                if (data.length === 0) {
                    showEmptyState();
                } else {
                    data.forEach(msg => {
                        addMessage(msg.sender, msg.message);
                    });
                }
            }
        } catch (err) {
            console.error("Failed to load historical messages:", err);
            showEmptyState();
        } finally {
            // Hide the loading overlay after the initial message history fetch
            if (isInitialLoad) {
                isInitialLoad = false;
                if (loadingOverlay) {
                    setTimeout(() => {
                        loadingOverlay.classList.add("hidden");
                    }, 500); // Elegant 500ms delay to make it smooth
                }
            }
        }
    }

    loadMessages();

    // Render message bubble safely
    function addMessage(sender, message) {
        if (!messages) return;

        // Clear empty state if it is showing
        const emptyState = document.getElementById("emptyState");
        if (emptyState) {
            emptyState.remove();
        }

        const div = document.createElement("div");
        const isMe = sender === username;

        div.classList.add(isMe ? "my-message" : "other-message");

        const senderDiv = document.createElement("div");
        senderDiv.classList.add("sender");
        senderDiv.textContent = sender;

        const textDiv = document.createElement("div");
        textDiv.classList.add("text");

        // Code block parsing regex matching ```code``` blocks
        const codeBlockRegex = /```(?:[a-zA-Z0-9_-]+\n)?([\s\S]*?)```/g;
        let lastIndex = 0;
        let match;
        let hasCodeBlock = false;

        while ((match = codeBlockRegex.exec(message)) !== null) {
            hasCodeBlock = true;
            const textSegment = message.substring(lastIndex, match.index);
            const codeSegment = match[1];

            // Render preceding text segment if not empty
            if (textSegment) {
                const textSpan = document.createElement("span");
                textSpan.textContent = textSegment;
                textDiv.appendChild(textSpan);
            }

            // Render code segment inside <pre><code>
            const pre = document.createElement("pre");
            pre.classList.add("code-block-container");
            const code = document.createElement("code");
            code.classList.add("code-block");
            code.textContent = codeSegment; // textContent preserves exact spaces/tabs and handles HTML escaping completely
            pre.appendChild(code);
            textDiv.appendChild(pre);

            lastIndex = codeBlockRegex.lastIndex;
        }

        // Render remaining text segment if not empty
        if (lastIndex < message.length) {
            const remainingText = message.substring(lastIndex);
            const textSpan = document.createElement("span");
            textSpan.textContent = remainingText;
            textDiv.appendChild(textSpan);
        }

        // If no code blocks were found, default to direct textContent rendering
        if (!hasCodeBlock) {
            textDiv.textContent = message;
        }

        const copyBtn = document.createElement("button");
        copyBtn.classList.add("copy-btn");
        copyBtn.textContent = "Copy";
        copyBtn.onclick = () => {
            navigator.clipboard.writeText(message);
        };

        div.appendChild(senderDiv);
        div.appendChild(textDiv);
        div.appendChild(copyBtn);

        messages.appendChild(div);
        messages.scrollTop = messages.scrollHeight;
    }

    // Message Sending Logic
    function handleSend() {
        if (cooldownActive || !messageInput) return;

        const message = messageInput.value.trim();
        if (message === "") return;

        // Immediately cease typing status
        stopTyping();

        // Trigger the anti-spam 400ms button cooldown
        triggerSendCooldown();

        socket.emit("send-message", {
            message
        });

        messageInput.value = "";
    }

    if (sendBtn) {
        sendBtn.onclick = handleSend;
    }

    if (messageInput) {
        messageInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault(); // Prevent default newline insertion in textarea
                handleSend();
            }
        });
    }

    // Real-Time Events
    socket.on("receive-message", (data) => {
        addMessage(data.sender, data.message);
    });

    // Real-Time Multi-User Typing Indicator
    const typingUsers = new Set();

    socket.on("typing", (data) => {
        const { username: typingUsername, isTyping } = data;

        if (isTyping) {
            typingUsers.add(typingUsername);
        } else {
            typingUsers.delete(typingUsername);
        }

        updateTypingIndicator();
    });

    function updateTypingIndicator() {
        const typingDiv = document.getElementById("typing");
        if (!typingDiv) return;

        const usersArray = Array.from(typingUsers);

        if (usersArray.length === 0) {
            typingDiv.classList.remove("active");
            setTimeout(() => {
                if (!typingDiv.classList.contains("active")) {
                    typingDiv.innerHTML = "";
                }
            }, 300);
            return;
        }

        let text = "";
        if (usersArray.length === 1) {
            text = `${usersArray[0]} is typing`;
        } else if (usersArray.length === 2) {
            text = `${usersArray[0]} and ${usersArray[1]} are typing`;
        } else {
            text = `${usersArray[0]}, ${usersArray[1]} and ${usersArray.length - 2} others are typing`;
        }

        typingDiv.innerHTML = `${text}<span class="typing-dots"><span></span><span></span><span></span></span>`;
        typingDiv.classList.add("active");
    }

    // Active User sidebar + admin controls
    socket.on("user-list", (users) => {
        const onlineUsers = document.getElementById("onlineUsers");
        if (!onlineUsers) return;

        onlineUsers.innerHTML = "";

        users.forEach(user => {
            const div = document.createElement("div");
            div.classList.add("user");

            const userInfo = document.createElement("div");
            userInfo.classList.add("user-info");

            const statusDot = document.createElement("span");
            statusDot.classList.add("status-dot", "online");

            const nameSpan = document.createElement("span");
            nameSpan.classList.add("user-name");
            nameSpan.textContent = user.username;

            userInfo.appendChild(statusDot);
            userInfo.appendChild(nameSpan);

            if (user.role === "admin") {
                const badge = document.createElement("span");
                badge.classList.add("admin-badge");
                badge.textContent = "ADMIN";
                userInfo.appendChild(badge);
            }

            div.appendChild(userInfo);

            if (isAdmin && user.id !== clientId) {
                const actions = document.createElement("div");
                actions.classList.add("user-actions");

                const kickBtn = document.createElement("button");
                kickBtn.classList.add("user-action-btn", "kick-btn");
                kickBtn.textContent = "Kick";
                kickBtn.title = `Kick ${user.username}`;
                kickBtn.onclick = () => {
                    if (confirm(`Kick ${user.username} from this room?`)) {
                        socket.emit("kick-user", { userId: user.id });
                    }
                };

                const blockBtn = document.createElement("button");
                blockBtn.classList.add("user-action-btn", "block-btn");
                blockBtn.textContent = "Block";
                blockBtn.title = `Block ${user.username}`;
                blockBtn.onclick = () => {
                    if (confirm(`Block ${user.username} from this room?`)) {
                        socket.emit("block-user", { userId: user.id });
                    }
                };

                actions.appendChild(kickBtn);
                actions.appendChild(blockBtn);
                div.appendChild(actions);
            }

            onlineUsers.appendChild(div);
        });
    });

    socket.on("room-state", (state) => {
        isAdmin = state.role === "admin";

        const adminPanel = document.getElementById("adminPanel");
        const clearChatBtn = document.getElementById("clearChatBtn");

        if (adminPanel) {
            adminPanel.classList.toggle("hidden", !isAdmin);
        }

        if (clearChatBtn) {
            clearChatBtn.classList.toggle("hidden", !isAdmin);
        }
    });

    socket.on("blocked-list", (users) => {
        blockedUsers = Array.isArray(users) ? users : [];
        renderBlockedUsers();
    });

    function renderBlockedUsers() {
        const blockedList = document.getElementById("blockedUsers");
        if (!blockedList || !isAdmin) return;

        blockedList.innerHTML = "";

        if (blockedUsers.length === 0) {
            const empty = document.createElement("div");
            empty.classList.add("blocked-empty");
            empty.textContent = "No blocked users";
            blockedList.appendChild(empty);
            return;
        }

        blockedUsers.forEach(user => {
            const row = document.createElement("div");
            row.classList.add("blocked-user");

            const name = document.createElement("span");
            name.textContent = user.username;

            const unblock = document.createElement("button");
            unblock.classList.add("unblock-btn");
            unblock.textContent = "Unblock";
            unblock.onclick = () => {
                socket.emit("unblock-user", { userId: user.id });
            };

            row.appendChild(name);
            row.appendChild(unblock);
            blockedList.appendChild(row);
        });
    }

    // System event updates
    socket.on("system-message", (msg) => {
        if (!messages) return;

        // Clear empty state if a system event is posted
        const emptyState = document.getElementById("emptyState");
        if (emptyState) {
            emptyState.remove();
        }

        const div = document.createElement("div");
        div.classList.add("system-message");
        div.textContent = msg;

        messages.appendChild(div);
        messages.scrollTop = messages.scrollHeight;
    });

    socket.on("kicked", (message) => {
        window.location.href = `/index.html?error=${encodeURIComponent(message)}`;
    });

    socket.on("blocked", (message) => {
        window.location.href = `/index.html?error=${encodeURIComponent(message)}`;
    });

    socket.on("admin-error", (message) => {
        if (messages) {
            const div = document.createElement("div");
            div.classList.add("system-message");
            div.textContent = message;
            messages.appendChild(div);
            messages.scrollTop = messages.scrollHeight;
        }
    });

    socket.on("admin-notice", (message) => {
        if (!messages) return;
        const div = document.createElement("div");
        div.classList.add("system-message");
        div.textContent = message;
        messages.appendChild(div);
        messages.scrollTop = messages.scrollHeight;
    });

    // Confirmation Modal Event Listeners
    const clearChatBtn = document.getElementById("clearChatBtn");
    const clearModal = document.getElementById("clearModal");
    const modalCancelBtn = document.getElementById("modalCancelBtn");
    const modalConfirmBtn = document.getElementById("modalConfirmBtn");

    if (clearChatBtn && clearModal && modalCancelBtn && modalConfirmBtn) {
        clearChatBtn.onclick = () => {
            console.log("[Clear Chat] Modal opened");
            clearModal.classList.add("show");
        };

        modalCancelBtn.onclick = () => {
            console.log("[Clear Chat] Modal closed (Cancel clicked)");
            clearModal.classList.remove("show");
        };

        modalConfirmBtn.onclick = () => {
            console.log("[Clear Chat] Emitting clear-chat event for room:", roomId);
            clearModal.classList.remove("show");
            socket.emit("clear-chat", { roomId });
        };

        // Close modal if clicking outside the card
        clearModal.onclick = (e) => {
            if (e.target === clearModal) {
                console.log("[Clear Chat] Modal closed (Clicked overlay background)");
                clearModal.classList.remove("show");
            }
        };
    }

    // Real-Time Chat Clearing Listener (Safe & Smooth Animations)
    socket.on("chat-cleared", () => {
        console.log("[Clear Chat] Received chat-cleared event from server");
        if (!messages) return;

        const bubbles = messages.querySelectorAll(".my-message, .other-message, .system-message");
        if (bubbles.length === 0) {
            messages.innerHTML = "";
            showEmptyState();
            return;
        }

        bubbles.forEach(bubble => {
            bubble.classList.add("fade-out");
        });

        // Set timeout matching the CSS transition duration (300ms)
        setTimeout(() => {
            // Remove ONLY message bubbles, preserving container layout
            bubbles.forEach(bubble => bubble.remove());
            showEmptyState();
        }, 300);
    });
});
