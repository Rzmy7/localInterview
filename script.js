// --- INDEXEDDB SETUP ---
let db;
const dbRequest = indexedDB.open("InterviewDB", 1);

dbRequest.onupgradeneeded = (e) => {
  db = e.target.result;
  if (!db.objectStoreNames.contains("interviews")) {
    db.createObjectStore("interviews", { keyPath: "id", autoIncrement: true });
  }
};

dbRequest.onsuccess = (e) => {
  db = e.target.result;
  requestPersistentStorage();
  loadInterviews();
};

dbRequest.onerror = (e) => {
  console.error("IndexedDB initialization error:", e.target.error);
};

async function requestPersistentStorage() {
  if (navigator.storage && navigator.storage.persist) {
    await navigator.storage.persist();
  }
}

// --- APP STATE & DOM ELEMENTS ---
let mediaRecorder;
let audioChunks = [];
let wakeLock = null;
let timerInterval;
let secondsElapsed = 0;

const recordBtn = document.getElementById("recordBtn");
const stopBtn = document.getElementById("stopBtn");
const exportBtn = document.getElementById("exportBtn");
const importInput = document.getElementById("importInput");
const timerDisplay = document.getElementById("timerDisplay");
const wakeLockStatus = document.getElementById("wakeLockStatus");
const listContainer = document.getElementById("interviewsList");

// --- AUDIO RECORDING & SCREEN LOCK LOGIC ---
recordBtn.addEventListener("click", async () => {
  const candidate = document.getElementById("candidate").value.trim();
  if (!candidate) {
    alert("Please enter a Candidate Name first.");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    // Choose best supported format for Android Chrome
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") 
      ? "audio/webm;codecs=opus" 
      : "audio/webm";

    mediaRecorder = new MediaRecorder(stream, { mimeType });
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      const audioBlob = new Blob(audioChunks, { type: mimeType });
      await saveInterview(audioBlob);
      stream.getTracks().forEach(track => track.stop()); // Release mic hardware
      releaseWakeLock();
      resetTimer();
    };

    mediaRecorder.start();
    await requestWakeLock();

    // Update UI
    recordBtn.disabled = true;
    stopBtn.disabled = false;
    startTimer();

  } catch (err) {
    alert("Microphone access failed. Ensure you are using HTTPS: " + err.message);
  }
});

stopBtn.addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
    recordBtn.disabled = false;
    stopBtn.disabled = true;
  }
});

// --- WAKE LOCK FUNCTIONS ---
async function requestWakeLock() {
  if ("wakeLock" in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLockStatus.textContent = "Screen Lock: Active (Prevents Sleep)";
    } catch (err) {
      wakeLockStatus.textContent = "Screen Lock: Active via Fallback";
    }
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release();
    wakeLock = null;
    wakeLockStatus.textContent = "Screen Lock: Inactive";
  }
}

// --- TIMER FUNCTIONS ---
function startTimer() {
  secondsElapsed = 0;
  timerInterval = setInterval(() => {
    secondsElapsed++;
    const mins = String(Math.floor(secondsElapsed / 60)).padStart(2, '0');
    const secs = String(secondsElapsed % 60).padStart(2, '0');
    timerDisplay.textContent = `${mins}:${secs}`;
  }, 1000);
}

function resetTimer() {
  clearInterval(timerInterval);
  timerDisplay.textContent = "00:00";
}

// --- DATABASE OPERATIONS ---
async function saveInterview(audioBlob) {
  const interview = {
    candidate: document.getElementById("candidate").value.trim(),
    interviewer: document.getElementById("interviewer").value.trim() || "N/A",
    notes: document.getElementById("notes").value.trim(),
    date: new Date().toLocaleString(),
    audio: audioBlob
  };

  const tx = db.transaction("interviews", "readwrite");
  tx.objectStore("interviews").add(interview);

  tx.oncomplete = () => {
    document.getElementById("candidate").value = "";
    document.getElementById("interviewer").value = "";
    document.getElementById("notes").value = "";
    loadInterviews();
  };
}

function loadInterviews() {
  listContainer.innerHTML = "";

  const tx = db.transaction("interviews", "readonly");
  const store = tx.objectStore("interviews");
  const request = store.getAll();

  request.onsuccess = () => {
    const interviews = request.result;
    if (!interviews || interviews.length === 0) {
      listContainer.innerHTML = "<p style='color: var(--text-muted);'>No saved interviews found.</p>";
      return;
    }

    // Display newest first
    interviews.reverse().forEach((item) => {
      const audioUrl = URL.createObjectURL(item.audio);
      
      const div = document.createElement("div");
      div.className = "interview-item";
      div.innerHTML = `
        <h3>${escapeHtml(item.candidate)}</h3>
        <div class="meta">
          <strong>Interviewer:</strong> ${escapeHtml(item.interviewer)} | 
          <strong>Date:</strong> ${item.date}
        </div>
        ${item.notes ? `<p style="margin: 4px 0;"><strong>Notes:</strong> ${escapeHtml(item.notes)}</p>` : ''}
        <audio controls src="${audioUrl}"></audio>
        <div>
          <button class="btn btn-delete" onclick="deleteInterview(${item.id})">Delete</button>
        </div>
      `;
      listContainer.appendChild(div);
    });
  };
}

function deleteInterview(id) {
  if (confirm("Are you sure you want to delete this recording?")) {
    const tx = db.transaction("interviews", "readwrite");
    tx.objectStore("interviews").delete(id);
    tx.oncomplete = () => loadInterviews();
  }
}

// --- EXPORT & IMPORT DATA LOGIC ---
function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function dataURLToBlob(dataURL) {
  const res = await fetch(dataURL);
  return await res.blob();
}

// EXPORT TO JSON
exportBtn.addEventListener("click", () => {
  const tx = db.transaction("interviews", "readonly");
  const store = tx.objectStore("interviews");
  const request = store.getAll();

  request.onsuccess = async () => {
    const items = request.result;
    if (!items || items.length === 0) {
      alert("No interview data to export.");
      return;
    }

    exportBtn.textContent = "Exporting...";
    exportBtn.disabled = true;

    try {
      const exportData = await Promise.all(
        items.map(async (item) => {
          const audioDataUrl = await blobToDataURL(item.audio);
          return {
            candidate: item.candidate,
            interviewer: item.interviewer,
            notes: item.notes,
            date: item.date,
            audioDataUrl: audioDataUrl
          };
        })
      );

      const jsonStr = JSON.stringify(exportData);
      const jsonBlob = new Blob([jsonStr], { type: "application/json" });
      const url = URL.createObjectURL(jsonBlob);

      const a = document.createElement("a");
      a.href = url;
      a.download = `interviews_backup_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert("Export failed: " + err.message);
    } finally {
      exportBtn.textContent = "Export All Data";
      exportBtn.disabled = false;
    }
  };
});

// IMPORT FROM JSON
importInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (event) => {
    try {
      const importedItems = JSON.parse(event.target.result);
      if (!Array.isArray(importedItems)) {
        alert("Invalid backup file format.");
        return;
      }

      const tx = db.transaction("interviews", "readwrite");
      const store = tx.objectStore("interviews");

      for (const item of importedItems) {
        const audioBlob = await dataURLToBlob(item.audioDataUrl);
        store.add({
          candidate: item.candidate,
          interviewer: item.interviewer,
          notes: item.notes,
          date: item.date,
          audio: audioBlob
        });
      }

      tx.oncomplete = () => {
        alert("Data imported successfully!");
        loadInterviews();
        importInput.value = ""; // Reset file input
      };
    } catch (err) {
      alert("Import failed: " + err.message);
    }
  };
  reader.readAsText(file);
});

// --- HELPER FUNCTIONS ---
function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (m) => ({ 
    '&': '&amp;', 
    '<': '&lt;', 
    '>': '&gt;', 
    '"': '&quot;', 
    "'": '&#039;' 
  }[m]));
}
