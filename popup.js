"use strict";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const ALL_STATES = [
  "state-initial",
  "state-folders",
  "state-loading",
  "state-results",
  "state-complete",
  "state-error"
];

const appState = {
  bookmarks: [],
  folders: [],
  results: [],
  // "unsorted" = sort root-level bookmarks, "folders" = re-sort selected folders
  mode: "unsorted"
};

const nodes = {};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function q(id) {
  return document.getElementById(id);
}

function setView(activeId) {
  for (const id of ALL_STATES) {
    const el = q(id);
    if (el) el.classList.toggle("hidden", id !== activeId);
  }
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(response);
    });
  });
}


function truncateUrl(url) {
  if (!url) return "";
  return url.length > 72 ? url.slice(0, 69) + "..." : url;
}

// ---------------------------------------------------------------------------
// Confidence heuristic
// ---------------------------------------------------------------------------

function inferConfidence(result) {
  const reason = (result.reasoning || "").toLowerCase();
  if (result.matchedFolder && /(exact|clearly|strong|direct)/.test(reason)) return "high";
  if (result.matchedFolder && /(likely|probably|close|related)/.test(reason)) return "medium";
  if (result.matchedFolder) return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// Result cards
// ---------------------------------------------------------------------------

function createCard(result) {
  const card = document.createElement("div");
  const action = result.matchedFolder ? "move" : result.suggestedNewFolder ? "create" : "none";
  card.className = "bookmark-card";
  card.dataset.bookmarkId = result.bookmark.id;
  card.dataset.action = action;
  card.dataset.originParentId = result.bookmark.parentId || "1";

  if (result.matchedFolder) {
    card.dataset.targetFolderId = result.matchedFolder.id;
  }

  const confidence = inferConfidence(result) || "low";
  const confidenceLabel = confidence[0].toUpperCase() + confidence.slice(1);

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "card-checkbox";
  checkbox.checked = action !== "none";

  const content = document.createElement("div");
  content.className = "card-content";

  const title = document.createElement("div");
  title.className = "card-title";
  title.textContent = result.bookmark.title || "Untitled Bookmark";

  const url = document.createElement("div");
  url.className = "card-url";
  url.textContent = truncateUrl(result.bookmark.url || "");

  const suggestion = document.createElement("div");
  suggestion.className = "card-suggestion";

  if (action === "move") {
    const label = document.createElement("span");
    label.className = "suggestion-label";
    label.textContent = "Move to:";
    const fname = document.createElement("span");
    fname.className = "folder-name";
    // Show the full path (e.g. "Tech > JavaScript") for clarity.
    fname.textContent = result.matchedPath || result.matchedFolder.title;
    const badge = document.createElement("span");
    badge.className = "confidence-badge confidence-" + confidence;
    badge.textContent = confidenceLabel;
    suggestion.append(label, fname, badge);
  } else if (action === "create") {
    const label = document.createElement("span");
    label.className = "suggestion-label";
    label.textContent = "Create folder:";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "folder-input";
    input.value = result.suggestedNewFolder;
    const badge = document.createElement("span");
    badge.className = "confidence-badge confidence-" + confidence;
    badge.textContent = confidenceLabel;
    suggestion.append(label, input, badge);
  } else {
    const label = document.createElement("span");
    label.className = "suggestion-label";
    label.textContent = "No suggestion available.";
    suggestion.append(label);
  }

  const reasoning = document.createElement("div");
  reasoning.className = "card-reasoning";
  reasoning.textContent = result.reasoning || "No reasoning provided.";

  content.append(title, url, suggestion, reasoning);
  card.append(checkbox, content);
  return card;
}

function renderResults(results) {
  nodes.resultsList.innerHTML = "";

  if (!results.length) {
    const empty = document.createElement("div");
    empty.className = "status-bar";
    empty.textContent = "No actionable suggestions were returned.";
    nodes.resultsList.appendChild(empty);
  }

  for (const result of results) {
    nodes.resultsList.appendChild(createCard(result));
  }

  const actionable = results.filter((r) => r.matchedFolder || r.suggestedNewFolder).length;
  nodes.resultsCount.textContent = actionable + " of " + results.length + " actionable";
}

// ---------------------------------------------------------------------------
// Folder picker (for re-sort feature)
// ---------------------------------------------------------------------------

function renderFolderPicker(folders) {
  nodes.folderPickerList.innerHTML = "";

  // Build a map from id to folder for nesting display.
  // Only show top-level folders (those whose parentId is "1" or "2") as checkable.
  // Show subfolders indented underneath to give context.
  const topLevel = folders.filter(
    (f) => f.parentId === "1" || f.parentId === "2"
  );

  if (!topLevel.length) {
    const empty = document.createElement("div");
    empty.className = "status-bar";
    empty.textContent = "No bookmark folders found.";
    nodes.folderPickerList.appendChild(empty);
    return;
  }

  // Collect children for each folder.
  const childrenOf = new Map();
  for (const f of folders) {
    if (!childrenOf.has(f.parentId)) childrenOf.set(f.parentId, []);
    childrenOf.get(f.parentId).push(f);
  }

  function addFolderRow(folder, depth) {
    const row = document.createElement("label");
    row.className = "folder-row";
    row.style.paddingLeft = (12 + depth * 18) + "px";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "folder-checkbox";
    cb.value = folder.id;
    cb.dataset.folderPath = folder.path;

    const name = document.createElement("span");
    name.className = "folder-row-name";
    name.textContent = folder.title;

    // Show bookmark count hint.
    const sub = childrenOf.get(folder.id);
    if (sub && sub.length) {
      const hint = document.createElement("span");
      hint.className = "folder-row-hint";
      hint.textContent = "(" + sub.length + " subfolder" + (sub.length > 1 ? "s" : "") + ")";
      name.append(" ", hint);
    }

    row.append(cb, name);
    nodes.folderPickerList.appendChild(row);

    // Recurse into children.
    if (sub) {
      for (const child of sub) {
        addFolderRow(child, depth + 1);
      }
    }
  }

  for (const folder of topLevel) {
    addFolderRow(folder, 0);
  }

  nodes.folderPickerCount.textContent = topLevel.length + " top-level folder" + (topLevel.length > 1 ? "s" : "");
}

function getSelectedFolderIds() {
  const checked = nodes.folderPickerList.querySelectorAll(".folder-checkbox:checked");
  return Array.from(checked).map((cb) => cb.value);
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

function updateProgress(current, total) {
  if (!total) {
    nodes.progressBar.style.width = "0%";
    nodes.progressText.textContent = "";
    return;
  }
  const pct = Math.min(100, Math.round((current / total) * 100));
  nodes.progressBar.style.width = pct + "%";
  nodes.progressText.textContent = "Classified " + current + " of " + total;
}

function resetProgress() {
  nodes.progressBarContainer.classList.add("hidden");
  nodes.progressBar.style.width = "0%";
  nodes.progressText.textContent = "";
}

// ---------------------------------------------------------------------------
// Apply changes
// ---------------------------------------------------------------------------

function collectSelectedCards() {
  return Array.from(nodes.resultsList.querySelectorAll(".bookmark-card")).filter((card) => {
    const cb = card.querySelector(".card-checkbox");
    return cb && cb.checked;
  });
}

async function applySelectedChanges() {
  const cards = collectSelectedCards();
  if (!cards.length) {
    nodes.resultsCount.textContent = "Please select at least one bookmark.";
    nodes.resultsCount.classList.add("status-warn");
    return;
  }
  nodes.resultsCount.classList.remove("status-warn");

  setView("state-loading");
  nodes.loadingMessage.textContent = "Applying changes...";
  nodes.progressBarContainer.classList.remove("hidden");
  updateProgress(0, cards.length);

  const createdFoldersByName = new Map();
  let moved = 0;
  let failed = 0;

  for (let i = 0; i < cards.length; i += 1) {
    const card = cards[i];
    const bookmarkId = card.dataset.bookmarkId;
    const action = card.dataset.action;

    try {
      if (action === "move") {
        const resp = await sendMessage({
          type: "moveBookmark",
          bookmarkId,
          targetFolderId: card.dataset.targetFolderId
        });
        if (!resp?.success) throw new Error(resp?.error || "Move failed");
        moved += 1;
      } else if (action === "create") {
        const input = card.querySelector(".folder-input");
        const folderName = (input?.value || "").trim();
        if (!folderName) throw new Error("Folder name cannot be empty.");

        const cacheKey = folderName.toLowerCase();
        if (createdFoldersByName.has(cacheKey)) {
          const resp = await sendMessage({
            type: "moveBookmark",
            bookmarkId,
            targetFolderId: createdFoldersByName.get(cacheKey)
          });
          if (!resp?.success) throw new Error(resp?.error || "Move failed");
        } else {
          const resp = await sendMessage({
            type: "createFolderAndMove",
            bookmarkId,
            folderName,
            parentId: card.dataset.originParentId || "1"
          });
          if (!resp?.success) throw new Error(resp?.error || "Create failed");
          createdFoldersByName.set(cacheKey, resp.folderId);
        }
        moved += 1;
      }
    } catch (error) {
      console.error("Apply failed for bookmark:", bookmarkId, error);
      failed += 1;
    }

    updateProgress(i + 1, cards.length);
  }

  nodes.completeSummary.textContent =
    failed > 0
      ? "Moved " + moved + " bookmark(s). " + failed + " failed."
      : "Moved " + moved + " bookmark(s) successfully.";
  setView("state-complete");
}

// ---------------------------------------------------------------------------
// Model status panel
// ---------------------------------------------------------------------------

function setModelStatus(status) {
  const badge = nodes.modelStatusBadge;
  const detail = nodes.modelStatusDetail;
  const downloadBtn = nodes.btnDownloadModel;
  const downloadBar = nodes.modelDownloadBar;

  // Reset
  badge.className = "model-badge";
  downloadBtn.classList.add("hidden");
  downloadBar.classList.add("hidden");

  switch (status) {
    case "available":
      badge.classList.add("model-badge-available");
      badge.textContent = "Ready";
      detail.textContent = "Gemini Nano is installed and ready to use.";
      break;
    case "downloadable":
      badge.classList.add("model-badge-downloadable");
      badge.textContent = "Not Downloaded";
      detail.textContent = "The model needs to be downloaded (~22 GB). Click below to start.";
      downloadBtn.classList.remove("hidden");
      break;
    case "downloading":
      badge.classList.add("model-badge-downloading");
      badge.textContent = "Downloading...";
      detail.textContent = "The model is being downloaded. This may take a while.";
      downloadBar.classList.remove("hidden");
      break;
    case "unavailable":
      badge.classList.add("model-badge-unavailable");
      badge.textContent = "Unavailable";
      detail.textContent = "Enable the required Chrome flags and restart Chrome. See Setup Required below.";
      break;
    default:
      badge.classList.add("model-badge-unknown");
      badge.textContent = "Checking...";
      detail.textContent = "";
      break;
  }
}

function updateModelDownloadProgress(fraction) {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  nodes.modelDownloadFill.style.width = pct + "%";
  nodes.modelDownloadBar.classList.remove("hidden");
  nodes.modelStatusDetail.textContent = "Downloading model: " + pct + "%";
  nodes.modelStatusBadge.textContent = pct + "%";
}

async function triggerModelDownload() {
  nodes.btnDownloadModel.disabled = true;
  nodes.btnDownloadModel.textContent = "Downloading...";
  setModelStatus("downloading");

  try {
    const resp = await sendMessage({ type: "triggerModelDownload" });
    if (resp?.success) {
      setModelStatus("available");
      // Re-run init to enable scan buttons now that the model is ready.
      await loadInitialData();
    } else {
      nodes.modelStatusDetail.textContent = resp?.error || "Download failed. Check flags and try again.";
      nodes.btnDownloadModel.disabled = false;
      nodes.btnDownloadModel.textContent = "Retry Download";
      nodes.btnDownloadModel.classList.remove("hidden");
    }
  } catch (error) {
    console.error("Model download error:", error);
    nodes.modelStatusDetail.textContent = "Download failed: " + error.message;
    nodes.btnDownloadModel.disabled = false;
    nodes.btnDownloadModel.textContent = "Retry Download";
    nodes.btnDownloadModel.classList.remove("hidden");
  }
}

// ---------------------------------------------------------------------------
// Load & scan flows
// ---------------------------------------------------------------------------

async function loadInitialData() {
  appState.bookmarks = [];
  appState.folders = [];
  appState.results = [];
  appState.mode = "unsorted";

  setView("state-initial");
  nodes.btnScan.disabled = true;
  nodes.btnShowFolders.disabled = true;
  resetProgress();
  setModelStatus("unknown");

  try {
    const ai = await sendMessage({ type: "checkAIAvailability" });
    if (!ai?.success) {
      setModelStatus("unavailable");
      throw new Error(
        ai?.error || "Chrome Built-in AI not available. Please use Chrome 138+ with the required flags enabled."
      );
    }

    // Update model status panel.
    setModelStatus(ai.status);

    if (ai.status === "unavailable") {
      throw new Error("AI is unavailable. Enable required flags and wait for model download to complete.");
    }

    // Allow scan even when downloadable/downloading — LanguageModel.create() will
    // trigger or wait for the download automatically.
    const canScan = ai.status === "available" || ai.status === "downloadable" || ai.status === "downloading";

    const data = await sendMessage({ type: "getUnsortedBookmarks" });
    if (!data?.success) throw new Error(data?.error || "Unable to read bookmarks.");

    appState.bookmarks = Array.isArray(data.bookmarks) ? data.bookmarks : [];
    appState.folders = Array.isArray(data.folders) ? data.folders : [];

    if (!appState.bookmarks.length) {
      nodes.bookmarkCount.textContent = "No unsorted bookmarks found. You're already tidy!";
      nodes.btnScan.disabled = true;
    } else {
      nodes.bookmarkCount.textContent = "Found " + appState.bookmarks.length + " unsorted bookmark(s).";
      nodes.btnScan.disabled = !canScan;
    }

    // Always allow folder re-sort if there are folders and model is usable.
    nodes.btnShowFolders.disabled = !appState.folders.length || !canScan;
  } catch (error) {
    console.error("Initialization error:", error);
    nodes.errorMessage.textContent = error.message;
    setView("state-error");
  }
}

async function startScanUnsorted() {
  if (!appState.bookmarks.length) return;
  appState.mode = "unsorted";
  nodes.btnScan.disabled = true;

  setView("state-loading");
  nodes.loadingMessage.textContent = "Classifying bookmarks with Gemini Nano...";
  nodes.progressBarContainer.classList.remove("hidden");
  updateProgress(0, appState.bookmarks.length);

  try {
    const resp = await sendMessage({
      type: "classifyBookmarks",
      bookmarks: appState.bookmarks,
      folders: appState.folders
    });
    if (!resp?.success) throw new Error(resp?.error || "Classification failed.");

    appState.results = Array.isArray(resp.results) ? resp.results : [];
    renderResults(appState.results);
    setView("state-results");
  } catch (error) {
    console.error("Scan failed:", error);
    nodes.errorMessage.textContent = error.message;
    setView("state-error");
  }
}

async function startResortFolders() {
  const selectedIds = getSelectedFolderIds();
  if (!selectedIds.length) {
    nodes.folderPickerCount.textContent = "Please select at least one folder.";
    nodes.folderPickerCount.classList.add("status-warn");
    return;
  }
  nodes.folderPickerCount.classList.remove("status-warn");
  nodes.folderPickerCount.textContent = selectedIds.length + " folder(s) selected";
  appState.mode = "folders";

  setView("state-loading");
  nodes.loadingMessage.textContent = "Loading bookmarks from selected folders...";
  resetProgress();

  try {
    // Fetch bookmarks inside the selected folders.
    const data = await sendMessage({ type: "getBookmarksInFolders", folderIds: selectedIds });
    if (!data?.success) throw new Error(data?.error || "Unable to read bookmarks.");

    const bookmarks = Array.isArray(data.bookmarks) ? data.bookmarks : [];
    const folders = Array.isArray(data.folders) ? data.folders : [];

    if (!bookmarks.length) {
      nodes.completeSummary.textContent = "No bookmarks found in the selected folder(s).";
      setView("state-complete");
      return;
    }

    appState.bookmarks = bookmarks;
    appState.folders = folders;

    nodes.loadingMessage.textContent = "Classifying " + bookmarks.length + " bookmark(s) with Gemini Nano...";
    nodes.progressBarContainer.classList.remove("hidden");
    updateProgress(0, bookmarks.length);

    const resp = await sendMessage({
      type: "classifyBookmarks",
      bookmarks,
      folders
    });
    if (!resp?.success) throw new Error(resp?.error || "Classification failed.");

    appState.results = Array.isArray(resp.results) ? resp.results : [];
    renderResults(appState.results);
    setView("state-results");
  } catch (error) {
    console.error("Re-sort failed:", error);
    nodes.errorMessage.textContent = error.message;
    setView("state-error");
  }
}

function showFolderPicker() {
  renderFolderPicker(appState.folders);
  setView("state-folders");
}

// ---------------------------------------------------------------------------
// Event binding
// ---------------------------------------------------------------------------

function bindEvents() {
  nodes.btnScan.addEventListener("click", startScanUnsorted);
  nodes.btnShowFolders.addEventListener("click", showFolderPicker);
  nodes.btnDownloadModel.addEventListener("click", triggerModelDownload);
  nodes.btnResortSelected.addEventListener("click", startResortFolders);
  nodes.btnFoldersBack.addEventListener("click", loadInitialData);

  nodes.btnApplyAll.addEventListener("click", async () => {
    for (const cb of nodes.resultsList.querySelectorAll(".card-checkbox")) {
      cb.checked = true;
    }
    await applySelectedChanges();
  });
  nodes.btnApplySelected.addEventListener("click", applySelectedChanges);
  nodes.btnCancel.addEventListener("click", loadInitialData);
  nodes.btnDone.addEventListener("click", loadInitialData);
  nodes.btnRetry.addEventListener("click", loadInitialData);

  // Live progress updates from the background service worker.
  chrome.runtime.onMessage.addListener((message) => {
    if (!message?.type) return;

    if (message.type === "classifyProgress") {
      updateProgress(message.current ?? 0, message.total ?? appState.bookmarks.length);
      return;
    }

    if (message.type === "modelDownloadProgress") {
      const val = typeof message.progress === "number" ? message.progress : 0;

      // Update model status panel (visible on initial screen).
      updateModelDownloadProgress(val);

      // Also update loading screen progress bar (visible during scan).
      nodes.loadingMessage.textContent = "Downloading AI model...";
      nodes.progressBarContainer.classList.remove("hidden");
      const pct = Math.max(0, Math.min(100, Math.round(val * 100)));
      nodes.progressBar.style.width = pct + "%";
      nodes.progressText.textContent = "Model download: " + pct + "%";
    }
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", async () => {
  nodes.bookmarkCount = q("bookmark-count");
  nodes.loadingMessage = q("loading-message");
  nodes.progressBarContainer = q("progress-bar-container");
  nodes.progressBar = q("progress-bar");
  nodes.progressText = q("progress-text");
  nodes.resultsCount = q("results-count");
  nodes.resultsList = q("results-list");
  nodes.completeSummary = q("complete-summary");
  nodes.errorMessage = q("error-message");
  nodes.folderPickerList = q("folder-picker-list");
  nodes.folderPickerCount = q("folder-picker-count");

  // Model status panel.
  nodes.modelStatusBadge = q("model-status-badge");
  nodes.modelStatusDetail = q("model-status-detail");
  nodes.modelDownloadBar = q("model-download-bar");
  nodes.modelDownloadFill = q("model-download-fill");

  // Buttons.
  nodes.btnScan = q("btn-scan");
  nodes.btnShowFolders = q("btn-show-folders");
  nodes.btnDownloadModel = q("btn-download-model");
  nodes.btnResortSelected = q("btn-resort-selected");
  nodes.btnFoldersBack = q("btn-folders-back");
  nodes.btnApplyAll = q("btn-apply-all");
  nodes.btnApplySelected = q("btn-apply-selected");
  nodes.btnCancel = q("btn-cancel");
  nodes.btnDone = q("btn-done");
  nodes.btnRetry = q("btn-retry");

  bindEvents();
  await loadInitialData();
});
