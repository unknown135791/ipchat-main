document.addEventListener("DOMContentLoaded", () => {
    const socket = io();
    const params = new URLSearchParams(window.location.search);
    const roomId = params.get("room");
    const username = params.get("username") || "Anonymous";

    if (!roomId) {
        window.location.href = "/index.html?error=Room%20ID%20is%20required";
        return;
    }

    let clientId = localStorage.getItem("ipchat_client_id");
    if (!clientId) {
        clientId = (crypto.randomUUID ? crypto.randomUUID() : "c_" + Math.random().toString(36).slice(2) + Date.now().toString(36));
        localStorage.setItem("ipchat_client_id", clientId);
    }

    document.title = `IPChat | Room ${roomId}`;
    document.getElementById("roomTitle").innerText = `Room ${roomId}`;

    const messages = document.getElementById("messages");
    const messageInput = document.getElementById("messageInput");
    const sendBtn = document.getElementById("sendBtn");
    const connectionStatus = document.getElementById("connectionStatus");
    const loadingOverlay = document.getElementById("loadingOverlay");
    const onlineUsers = document.getElementById("onlineUsers");
    const adminPanel = document.getElementById("adminPanel");
    const blockedUsers = document.getElementById("blockedUsers");
    const clearChatBtn = document.getElementById("clearChatBtn");
    const toggleSidebarBtn = document.getElementById("toggleSidebarBtn");
    const sidebar = document.querySelector(".sidebar");
    const sidebarOverlay = document.getElementById("sidebarOverlay");

    if (toggleSidebarBtn && sidebar && sidebarOverlay) {
        toggleSidebarBtn.onclick = () => { sidebar.classList.toggle("open"); sidebarOverlay.classList.toggle("show"); };
        sidebarOverlay.onclick = () => { sidebar.classList.remove("open"); sidebarOverlay.classList.remove("show"); };
    }

    let typingTimeout = null, localIsTyping = false, cooldownActive = false, joined = false, isAdmin = false;
    let blockedIds = [];

    function hideLoading() {
        if (loadingOverlay) loadingOverlay.classList.add("hidden");
    }

    socket.emit("join-room", { roomId, username, clientId });

    socket.on("connect", () => {
        if (connectionStatus) connectionStatus.classList.remove("show");
        if (!cooldownActive && sendBtn) sendBtn.disabled = false;
        if (messageInput) { messageInput.disabled = false; messageInput.placeholder = "Type message..."; }
        if (joined) socket.emit("join-room", { roomId, username, clientId });
    });

    socket.on("disconnect", () => {
        if (connectionStatus) { connectionStatus.innerText = "Reconnecting to server..."; connectionStatus.classList.add("show"); }
        if (sendBtn) sendBtn.disabled = true;
        if (messageInput) { messageInput.disabled = true; messageInput.placeholder = "Disconnected from server..."; }
    });

    socket.on("join-success", (data) => {
        joined = true;
        isAdmin = data.role === "admin";
        adminPanel?.classList.toggle("hidden", !isAdmin);
        if (clearChatBtn) clearChatBtn.style.display = isAdmin ? "block" : "none";
        hideLoading();
        if (isAdmin) socket.emit("admin-get-blocks");
    });

    socket.on("join-failure", (errorMsg) => {
        hideLoading();
        alert(errorMsg);
        window.location.href = `/index.html?error=${encodeURIComponent(errorMsg)}`;
    });

    setTimeout(hideLoading, 12000);

    function showEmptyState() {
        if (!messages || document.getElementById("emptyState")) return;
        const emptyDiv = document.createElement("div");
        emptyDiv.id = "emptyState"; emptyDiv.classList.add("empty-state");
        const icon = document.createElement("div"); icon.classList.add("empty-state-icon"); icon.textContent = "💬";
        const title = document.createElement("div"); title.classList.add("empty-state-title"); title.textContent = "No messages yet";
        const subtitle = document.createElement("div"); subtitle.classList.add("empty-state-subtitle"); subtitle.textContent = "Be the first to start the conversation!";
        emptyDiv.append(icon, title, subtitle); messages.appendChild(emptyDiv);
    }

    async function loadMessages() {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);
            const res = await fetch(`/messages/${encodeURIComponent(roomId)}`, { signal: controller.signal });
            clearTimeout(timer);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (!data.length) showEmptyState(); else data.forEach(msg => addMessage(msg.sender, msg.message));
        } catch (err) {
            console.error("Failed to load historical messages:", err);
            showEmptyState();
        }
    }
    loadMessages();

    function addMessage(sender, message) {
        if (!messages) return;
        document.getElementById("emptyState")?.remove();
        const div = document.createElement("div");
        div.classList.add(sender === username ? "my-message" : "other-message");
        const senderDiv = document.createElement("div"); senderDiv.classList.add("sender"); senderDiv.textContent = sender;
        const textDiv = document.createElement("div"); textDiv.classList.add("text");
        const codeBlockRegex = /```(?:[a-zA-Z0-9_-]+\n)?([\s\S]*?)```/g;
        let lastIndex = 0, match, hasCodeBlock = false;
        while ((match = codeBlockRegex.exec(message)) !== null) {
            hasCodeBlock = true;
            const textSegment = message.substring(lastIndex, match.index);
            if (textSegment) { const span = document.createElement("span"); span.textContent = textSegment; textDiv.appendChild(span); }
            const pre = document.createElement("pre"); pre.classList.add("code-block-container");
            const code = document.createElement("code"); code.classList.add("code-block"); code.textContent = match[1]; pre.appendChild(code); textDiv.appendChild(pre);
            lastIndex = codeBlockRegex.lastIndex;
        }
        if (lastIndex < message.length) { const span = document.createElement("span"); span.textContent = message.substring(lastIndex); textDiv.appendChild(span); }
        if (!hasCodeBlock) textDiv.textContent = message;
        const copyBtn = document.createElement("button"); copyBtn.classList.add("copy-btn"); copyBtn.textContent = "Copy"; copyBtn.onclick = () => navigator.clipboard.writeText(message);
        div.append(senderDiv, textDiv, copyBtn); messages.appendChild(div); messages.scrollTop = messages.scrollHeight;
    }

    function stopTyping() {
        if (localIsTyping) { localIsTyping = false; clearTimeout(typingTimeout); socket.emit("typing", { isTyping: false }); }
    }
    function triggerSendCooldown() {
        cooldownActive = true; if (sendBtn) sendBtn.disabled = true;
        setTimeout(() => { cooldownActive = false; if (socket.connected && sendBtn) sendBtn.disabled = false; }, 400);
    }
    function handleSend() {
        if (cooldownActive || !messageInput || !joined) return;
        const message = messageInput.value.trim(); if (!message) return;
        stopTyping(); triggerSendCooldown(); socket.emit("send-message", { message }); messageInput.value = "";
    }
    sendBtn?.addEventListener("click", handleSend);
    messageInput?.addEventListener("input", () => {
        if (!localIsTyping) { localIsTyping = true; socket.emit("typing", { isTyping: true }); }
        clearTimeout(typingTimeout); typingTimeout = setTimeout(stopTyping, 2000);
    });
    messageInput?.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } });

    const typingUsers = new Set();
    socket.on("receive-message", data => addMessage(data.sender, data.message));
    socket.on("typing", data => { data.isTyping ? typingUsers.add(data.username) : typingUsers.delete(data.username); updateTypingIndicator(); });
    function updateTypingIndicator() {
        const typingDiv = document.getElementById("typing"); if (!typingDiv) return;
        const a = Array.from(typingUsers); if (!a.length) { typingDiv.classList.remove("active"); typingDiv.innerHTML = ""; return; }
        let text = a.length === 1 ? `${a[0]} is typing` : a.length === 2 ? `${a[0]} and ${a[1]} are typing` : `${a[0]}, ${a[1]} and ${a.length - 2} others are typing`;
        typingDiv.innerHTML = `${text}<span class="typing-dots"><span></span><span></span><span></span></span>`; typingDiv.classList.add("active");
    }

    function renderUsers(users) {
        if (!onlineUsers) return;
        onlineUsers.innerHTML = "";
        users.forEach(user => {
            const div = document.createElement("div"); div.classList.add("user");
            const statusDot = document.createElement("span"); statusDot.classList.add("status-dot", "online");
            const nameSpan = document.createElement("span"); nameSpan.textContent = user.username;
            div.append(statusDot, nameSpan);
            if (user.role === "admin") { const badge = document.createElement("span"); badge.className = "admin-badge"; badge.textContent = "ADMIN"; div.appendChild(badge); }
            if (isAdmin && user.clientId !== clientId && user.role !== "admin") {
                const actions = document.createElement("div"); actions.className = "user-actions";
                const kick = document.createElement("button"); kick.className = "user-action kick"; kick.textContent = "Kick"; kick.onclick = () => socket.emit("admin-kick", { clientId: user.clientId });
                const block = document.createElement("button"); block.className = "user-action block"; block.textContent = "Block"; block.onclick = () => { if (confirm(`Block ${user.username} from this room?`)) socket.emit("admin-block", { clientId: user.clientId }); };
                actions.append(kick, block); div.appendChild(actions);
            }
            onlineUsers.appendChild(div);
        });
    }

    socket.on("room-state", data => renderUsers(data.users || []));
    socket.on("user-list", users => { if (!users || !users.length) return; /* room-state renders admin controls */ });

    function renderBlocked(ids) {
        blockedIds = ids || [];
        if (!isAdmin || !blockedUsers) return;
        blockedUsers.innerHTML = "";
        if (!blockedIds.length) { blockedUsers.textContent = "No blocked users"; return; }
        blockedIds.forEach(id => {
            const row = document.createElement("div"); row.className = "blocked-row";
            const label = document.createElement("span"); label.textContent = id.slice(0, 12) + "…";
            const btn = document.createElement("button"); btn.className = "user-action unblock"; btn.textContent = "Unblock"; btn.onclick = () => socket.emit("admin-unblock", { clientId: id });
            row.append(label, btn); blockedUsers.appendChild(row);
        });
    }
    socket.on("blocked-list", renderBlocked);
    socket.on("admin-info", msg => { alert(msg); if (isAdmin) socket.emit("admin-get-blocks"); });
    socket.on("admin-error", msg => alert(msg));
    socket.on("kicked", msg => { alert(msg); window.location.href = `/index.html?error=${encodeURIComponent(msg)}`; });
    socket.on("blocked", msg => { alert(msg); window.location.href = `/index.html?error=${encodeURIComponent(msg)}`; });

    socket.on("system-message", msg => {
        document.getElementById("emptyState")?.remove();
        if (!messages) return;
        const div = document.createElement("div"); div.classList.add("system-message"); div.textContent = msg; messages.appendChild(div); messages.scrollTop = messages.scrollHeight;
    });

    const clearModal = document.getElementById("clearModal");
    const modalCancelBtn = document.getElementById("modalCancelBtn");
    const modalConfirmBtn = document.getElementById("modalConfirmBtn");
    clearChatBtn?.addEventListener("click", () => clearModal?.classList.add("show"));
    modalCancelBtn?.addEventListener("click", () => clearModal?.classList.remove("show"));
    modalConfirmBtn?.addEventListener("click", () => { clearModal?.classList.remove("show"); socket.emit("clear-chat"); });
    clearModal?.addEventListener("click", e => { if (e.target === clearModal) clearModal.classList.remove("show"); });

    socket.on("chat-cleared", () => {
        if (!messages) return;
        const bubbles = messages.querySelectorAll(".my-message, .other-message, .system-message");
        bubbles.forEach(b => b.classList.add("fade-out"));
        setTimeout(() => { bubbles.forEach(b => b.remove()); showEmptyState(); }, 300);
    });
});
