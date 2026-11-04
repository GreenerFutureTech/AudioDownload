async function getActiveTab() {
    const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true
    });

    return tab;
}

async function refresh() {

    const tab = await getActiveTab();

    const response = await chrome.runtime.sendMessage({
        target: "background",
        type: "GET_TAB",
        tabId: tab.id
    });

    const container = document.getElementById("tracks");

    container.innerHTML = "";

    const tracks = response.state?.tracks || [];

    if (tracks.length === 0) {
        container.innerHTML = "<p>No audio found.</p>";
        return;
    }

    tracks.forEach(track => {

        const div = document.createElement("div");

        div.className = "track";

        div.innerHTML = `
            <strong>${track.filename}</strong><br>
            ${track.format}<br>
            <button data-id="${track.id}">
                Download
            </button>
        `;

        container.appendChild(div);
    });

    document.querySelectorAll("button[data-id]").forEach(btn => {

        btn.addEventListener("click", async () => {

            await chrome.runtime.sendMessage({
                target: "background",
                type: "DOWNLOAD_TRACK",
                tabId: tab.id,
                trackId: btn.dataset.id
            });
        });
    });
}

document.getElementById("scanBtn").addEventListener("click", async () => {

    const tab = await getActiveTab();

    await chrome.runtime.sendMessage({
        target: "background",
        type: "SCAN_TAB",
        tabId: tab.id
    });

    setTimeout(refresh, 500);
});

document.getElementById("recordBtn").addEventListener("click", async () => {

    const tab = await getActiveTab();

    await chrome.runtime.sendMessage({
        target: "background",
        type: "START_RECORDING",
        tabId: tab.id
    });
});

refresh();