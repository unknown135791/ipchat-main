// public/js/index.js

document.addEventListener("DOMContentLoaded", () => {
    const usernameInput = document.getElementById("usernameInput");
    const roomInput = document.getElementById("roomInput");
    const joinBtn = document.getElementById("joinBtn");
    const errorCard = document.getElementById("errorCard");
    const errorText = document.getElementById("errorText");

    // Regular Expression matching server specifications
    const usernameRegex = /^[a-zA-Z0-9_ -]{1,20}$/;
    const roomRegex = /^[a-zA-Z0-9_-]{1,20}$/;

    // Display URL error if exists
    const params = new URLSearchParams(window.location.search);
    const errorMsg = params.get("error");
    if (errorMsg) {
        showError(errorMsg);
    }

    function showError(message) {
        if (errorText && errorCard) {
            errorText.textContent = message;
            errorCard.classList.add("show");
        }
    }

    function hideError() {
        if (errorCard) {
            errorCard.classList.remove("show");
        }
    }

    joinBtn.onclick = () => {
        hideError();

        const username = usernameInput.value.trim();
        const room = roomInput.value.trim();

        if (!username || !room) {
            showError("Username and Room ID are both required.");
            return;
        }

        if (!usernameRegex.test(username)) {
            showError("Username must be 1-20 characters (letters, numbers, spaces, underscores, dashes).");
            return;
        }

        if (!roomRegex.test(room)) {
            showError("Room ID must be 1-20 characters (letters, numbers, underscores, dashes).");
            return;
        }

        // Navigate safely
        window.location.href = `/room.html?room=${encodeURIComponent(room)}&username=${encodeURIComponent(username)}`;
    };

    // Enable Enter key in form
    usernameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            roomInput.focus();
        }
    });

    roomInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            joinBtn.click();
        }
    });
});
