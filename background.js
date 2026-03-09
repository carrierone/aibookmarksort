"use strict";

const ROOT_BOOKMARKS_BAR_ID = "1";
const ROOT_OTHER_BOOKMARKS_ID = "2";
const FETCH_TIMEOUT_MS = 5000;
const MAX_PAGE_TEXT_LENGTH = 1500;

// ---------------------------------------------------------------------------
// Live classification state (in-memory, survives popup close/reopen)
// ---------------------------------------------------------------------------

const classifyJob = {
  active: false,
  cancelled: false,
  current: 0,
  total: 0,
  results: [],
  bookmarks: [],
  folders: [],
  mode: "unsorted"
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sendResponseSafe(sendResponse, payload) {
  try {
    sendResponse(payload);
  } catch (error) {
    console.error("Failed to send message response:", error);
  }
}

function sendProgress(type, data) {
  chrome.runtime.sendMessage({ type, ...data }, () => void chrome.runtime.lastError);
}

// ---------------------------------------------------------------------------
// Bookmark tree helpers
// ---------------------------------------------------------------------------

async function getBookmarkTree() {
  return chrome.bookmarks.getTree();
}

/**
 * Recursively collect all folders with their full path strings.
 * e.g. { id: "5", title: "JavaScript", path: "Tech > JavaScript", parentId: "4", children: [...] }
 */
function collectFoldersWithPaths(node, parentPath, result) {
  if (!node || !Array.isArray(node.children)) {
    return;
  }

  for (const child of node.children) {
    const isFolder = !child.url;
    const isRootLevel =
      child.id === ROOT_BOOKMARKS_BAR_ID ||
      child.id === ROOT_OTHER_BOOKMARKS_ID ||
      child.id === "0";

    if (isFolder && !isRootLevel) {
      const title = child.title || "Untitled Folder";
      const path = parentPath ? `${parentPath} > ${title}` : title;
      const folderEntry = {
        id: child.id,
        title,
        path,
        parentId: child.parentId || null,
        childFolderCount: 0
      };
      result.push(folderEntry);

      // Recurse into subfolders.
      const before = result.length;
      collectFoldersWithPaths(child, path, result);
      folderEntry.childFolderCount = result.length - before;
    } else if (isFolder) {
      // Root-level containers — recurse but don't add them as folders.
      collectFoldersWithPaths(child, "", result);
    }
  }
}

/**
 * Find a folder node by ID anywhere in the bookmark tree.
 */
function findNodeById(node, targetId) {
  if (!node) return null;
  if (node.id === targetId) return node;
  for (const child of node.children || []) {
    const found = findNodeById(child, targetId);
    if (found) return found;
  }
  return null;
}

/**
 * Extract bookmarks that are direct children of a specific folder
 * (i.e. not inside any subfolder of that folder).
 */
function extractUnsortedBookmarksFromFolder(treeRoot, folderId) {
  const folderNode = findNodeById(treeRoot, folderId);
  if (!folderNode || !Array.isArray(folderNode.children)) return [];

  const unsorted = [];
  for (const item of folderNode.children) {
    if (item.url) {
      unsorted.push({
        id: item.id,
        title: item.title || "Untitled Bookmark",
        url: item.url,
        parentId: item.parentId || folderId
      });
    }
  }
  return unsorted;
}

/**
 * Extract all bookmarks (recursively) that live inside the given folder IDs.
 */
function extractBookmarksInFolders(treeRoot, folderIds) {
  const idSet = new Set(folderIds);
  const bookmarks = [];

  function walk(node) {
    if (!node) return;
    if (node.url) {
      // It's a bookmark — check if its parent is one of the selected folders.
      if (idSet.has(node.parentId)) {
        bookmarks.push({
          id: node.id,
          title: node.title || "Untitled Bookmark",
          url: node.url,
          parentId: node.parentId
        });
      }
      return;
    }
    // It's a folder — walk its children.
    for (const child of node.children || []) {
      walk(child);
    }
  }

  walk(treeRoot);
  return bookmarks;
}

// ---------------------------------------------------------------------------
// Default bookmark folder detection
// ---------------------------------------------------------------------------

/**
 * Detect the folder Chrome defaults to when the user adds/edits a bookmark.
 * Uses getRecent(1) — the parent of the most recently added bookmark is
 * effectively the same folder Chrome pre-selects in the Add Bookmark dialog.
 * Returns the folder node, or falls back to Other Bookmarks.
 */
async function detectDefaultBookmarkFolder() {
  try {
    const recent = await chrome.bookmarks.getRecent(1);
    if (recent.length && recent[0].parentId) {
      const parents = await chrome.bookmarks.get(recent[0].parentId);
      if (parents.length) {
        return parents[0];
      }
    }
  } catch (error) {
    console.warn("Failed to detect default bookmark folder:", error);
  }
  // Fallback: Other Bookmarks (id "2").
  try {
    const fallback = await chrome.bookmarks.get(ROOT_OTHER_BOOKMARKS_ID);
    if (fallback.length) return fallback[0];
  } catch (_) { /* ignore */ }
  return { id: ROOT_OTHER_BOOKMARKS_ID, title: "Other Bookmarks" };
}

/**
 * Walk up from a folder to find which root it belongs to.
 * Returns "Bookmarks Bar", "Other Bookmarks", or the folder's own title.
 */
async function getRootName(folderId) {
  const rootNames = {
    [ROOT_BOOKMARKS_BAR_ID]: "Bookmarks Bar",
    [ROOT_OTHER_BOOKMARKS_ID]: "Other Bookmarks"
  };
  if (rootNames[folderId]) return rootNames[folderId];
  try {
    const nodes = await chrome.bookmarks.get(folderId);
    if (nodes.length && nodes[0].parentId) {
      return getRootName(nodes[0].parentId);
    }
  } catch (_) { /* ignore */ }
  return "Bookmarks";
}

// ---------------------------------------------------------------------------
// Message handlers: bookmark scanning
// ---------------------------------------------------------------------------

async function handleGetUnsortedBookmarks() {
  const tree = await getBookmarkTree();
  const root = Array.isArray(tree) ? tree[0] : null;
  if (!root) {
    return { success: true, bookmarks: [], folders: [], scanFolderName: "" };
  }

  // Detect the folder Chrome uses as the default for new bookmarks.
  const defaultFolder = await detectDefaultBookmarkFolder();
  const scanId = defaultFolder.id;

  // Determine a friendly name for the scanned folder.
  let scanFolderName = defaultFolder.title || "Bookmarks";
  if (scanId === ROOT_BOOKMARKS_BAR_ID) scanFolderName = "Bookmarks Bar";
  if (scanId === ROOT_OTHER_BOOKMARKS_ID) scanFolderName = "Other Bookmarks";

  // Extract bookmarks that are direct children of the detected folder.
  // If the detected folder isn't in the tree for any reason, fall back safely.
  let effectiveScanId = scanId;
  if (!findNodeById(root, effectiveScanId)) {
    if (findNodeById(root, ROOT_OTHER_BOOKMARKS_ID)) {
      effectiveScanId = ROOT_OTHER_BOOKMARKS_ID;
      scanFolderName = "Other Bookmarks";
    } else if (findNodeById(root, ROOT_BOOKMARKS_BAR_ID)) {
      effectiveScanId = ROOT_BOOKMARKS_BAR_ID;
      scanFolderName = "Bookmarks Bar";
    }
  }
  const bookmarks = extractUnsortedBookmarksFromFolder(root, effectiveScanId);

  const folders = [];
  collectFoldersWithPaths(root, "", folders);

  return { success: true, bookmarks, folders, scanFolderName };
}

async function handleGetBookmarksInFolders(payload) {
  const folderIds = Array.isArray(payload?.folderIds) ? payload.folderIds : [];
  if (!folderIds.length) {
    return { success: true, bookmarks: [], folders: [] };
  }

  const tree = await getBookmarkTree();
  const root = Array.isArray(tree) ? tree[0] : null;
  if (!root) {
    return { success: true, bookmarks: [], folders: [] };
  }

  const bookmarks = extractBookmarksInFolders(root, folderIds);
  const folders = [];
  collectFoldersWithPaths(root, "", folders);

  return { success: true, bookmarks, folders };
}

// ---------------------------------------------------------------------------
// AI availability
// ---------------------------------------------------------------------------

async function handleCheckAIAvailability() {
  if (typeof LanguageModel === "undefined") {
    return {
      success: false,
      error: "Chrome Built-in AI not available. Please use Chrome 138+ with the required flags enabled."
    };
  }

  try {
    const status = await LanguageModel.availability();
    return {
      success: true,
      status: ["available", "downloadable", "downloading", "unavailable"].includes(status)
        ? status
        : "unavailable"
    };
  } catch (error) {
    console.error("Failed to check AI availability:", error);
    return {
      success: false,
      error: "Chrome Built-in AI not available. Please use Chrome 138+ with the required flags enabled."
    };
  }
}

// ---------------------------------------------------------------------------
// Model download trigger
// ---------------------------------------------------------------------------

async function handleTriggerModelDownload() {
  if (typeof LanguageModel === "undefined") {
    return { success: false, error: "Chrome Built-in AI not available." };
  }

  let session;
  try {
    session = await LanguageModel.create({
      initialPrompts: [{ role: "system", content: "You are a helpful assistant." }],
      monitor(monitor) {
        if (!monitor || typeof monitor.addEventListener !== "function") return;
        monitor.addEventListener("downloadprogress", (event) => {
          const progress = event?.total > 0 ? event.loaded / event.total : 0;
          sendProgress("modelDownloadProgress", { progress });
        });
      }
    });
    return { success: true };
  } catch (error) {
    console.error("Model download/create failed:", error);
    return { success: false, error: error?.message || "Failed to download model." };
  } finally {
    if (session && typeof session.destroy === "function") {
      try { session.destroy(); } catch (_) { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Webpage content fetching (fallback for ambiguous bookmarks)
// ---------------------------------------------------------------------------

function stripHtmlTags(html) {
  // Remove script/style blocks, then strip tags, collapse whitespace.
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractMetaDescription(html) {
  // Handle both orderings: name before content, and content before name.
  const match =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
  return match ? match[1].trim() : "";
}

async function fetchPageContent(url) {
  if (!url || !url.startsWith("http")) {
    return null;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "Accept": "text/html" }
    });

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
      clearTimeout(timeoutId);
      return null;
    }

    // Keep the abort timeout active during body download so large pages don't hang.
    const html = await response.text();
    clearTimeout(timeoutId);
    const metaDesc = extractMetaDescription(html);
    const bodyText = stripHtmlTags(html);

    // Combine meta description + body text, capped to keep within context window.
    let combined = "";
    if (metaDesc) {
      combined = `Description: ${metaDesc}\n`;
    }
    combined += bodyText;

    return combined.slice(0, MAX_PAGE_TEXT_LENGTH) || null;
  } catch (error) {
    // Timeouts, network errors, dead links — all silently return null.
    console.warn("Failed to fetch page content for:", url, error?.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// AI classification
// ---------------------------------------------------------------------------

function getSystemPrompt() {
  return (
    "You are a bookmark organizer. You classify bookmarks by their SUBJECT MATTER — what the page is about — not by superficial words in the title or URL.\n\n" +

    "CRITICAL RULES:\n" +
    "- Almost every bookmark is a website. A folder named 'Web Development' or 'Web Site Dev' is for pages about BUILDING websites (coding, HTML, CSS, hosting, web frameworks). Do NOT put a random company homepage there just because it is a website.\n" +
    "- Classify by the TOPIC or INDUSTRY the page belongs to. A wallet company website belongs in 'Shopping', 'Fashion', 'Accessories', or 'Lifestyle' — NOT 'Web Development'.\n" +
    "- A 'Tools' or 'Dev Tools' folder is for developer tools and software utilities, not for a hardware store website.\n" +
    "- Read the domain name, page title, and any page content carefully to understand what the business/site actually does.\n" +
    "- If the bookmark is a company/brand homepage, classify it by what the company sells or does (e.g. clothing brand → Fashion/Shopping, restaurant → Food/Dining, bank → Finance).\n" +
    "- If the bookmark is documentation, a tutorial, or a code repository, classify by the technical subject.\n" +
    "- If the bookmark is a news article, classify by the article's topic, not by the news outlet.\n\n" +

    "FOLDER MATCHING:\n" +
    "- Folders are shown as paths with ' > ' separating levels (e.g. 'Tech > JavaScript > Frameworks').\n" +
    "- Always prefer the MOST SPECIFIC (deepest) subfolder that genuinely fits the topic.\n" +
    "- Only match a folder if the bookmark's subject truly belongs there. A weak keyword overlap is NOT a match.\n" +
    "- If no existing folder is a good topical fit, set matchedFolder to null and suggest a short new folder name that describes the subject (e.g. 'Fashion', 'Travel', 'Finance', 'Gaming').\n" +
    "- Prefer matching an existing folder over suggesting a new one, but only when the match is genuinely relevant.\n"
  );
}

function getResponseSchema() {
  return {
    type: "object",
    properties: {
      matchedFolder: {
        anyOf: [{ type: "string" }, { type: "null" }],
        description: "Exact path of best matching existing folder, or null if none fit"
      },
      suggestedNewFolder: {
        anyOf: [{ type: "string" }, { type: "null" }],
        description: "Suggested new folder name if no match, or null"
      },
      reasoning: {
        type: "string",
        description: "Brief explanation"
      }
    },
    required: ["matchedFolder", "suggestedNewFolder", "reasoning"]
  };
}

function parseModelOutput(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch (e) {
      console.warn("Unable to parse model output JSON:", e);
      return null;
    }
  }
}

function buildBookmarkPrompt(bookmark, folderPaths, pageContent) {
  const title = bookmark?.title || "Untitled Bookmark";
  const url = bookmark?.url || "";
  const list = folderPaths.length ? folderPaths.map((p) => `- ${p}`).join("\n") : "- (none)";

  let prompt = `Bookmark title: "${title}"\nURL: ${url}\n`;

  if (pageContent) {
    prompt += `\nPage content preview:\n${pageContent}\n`;
  }

  prompt +=
    "\nFirst, determine what this page is ABOUT — what subject, industry, product, or service does it cover?\n" +
    `Then pick the best matching folder from this list:\n${list}\n\n` +
    "Only match a folder if the bookmark's SUBJECT genuinely fits that folder's topic. " +
    "Do NOT match based on superficial word overlap (e.g. a company website does not belong in a 'Web Development' folder). " +
    "If no folder is a good topical fit, suggest a new folder name. " +
    "Return the EXACT folder path string from the list for matchedFolder.";

  return prompt;
}

async function classifySingleBookmark(session, bookmark, folderPaths, foldersByPath) {
  // --- First pass: title + URL only ---
  const prompt1 = buildBookmarkPrompt(bookmark, folderPaths, null);
  const response1 = await session.prompt(prompt1, {
    responseConstraint: getResponseSchema()
  });

  const parsed1 = parseModelOutput(response1) || {
    matchedFolder: null,
    suggestedNewFolder: null,
    reasoning: "Invalid response format."
  };

  const matchedPath1 =
    typeof parsed1.matchedFolder === "string" && foldersByPath.has(parsed1.matchedFolder)
      ? parsed1.matchedFolder
      : null;

  // If we got a confident match, return it.
  if (matchedPath1) {
    return buildResult(bookmark, matchedPath1, parsed1, foldersByPath);
  }

  // --- Second pass: fetch page content for better context ---
  const pageContent = await fetchPageContent(bookmark.url);
  if (!pageContent) {
    // Can't fetch — return whatever the first pass gave us.
    return buildResult(bookmark, null, parsed1, foldersByPath);
  }

  const prompt2 = buildBookmarkPrompt(bookmark, folderPaths, pageContent);
  const response2 = await session.prompt(prompt2, {
    responseConstraint: getResponseSchema()
  });

  const parsed2 = parseModelOutput(response2) || parsed1;
  const matchedPath2 =
    typeof parsed2.matchedFolder === "string" && foldersByPath.has(parsed2.matchedFolder)
      ? parsed2.matchedFolder
      : null;

  return buildResult(bookmark, matchedPath2, parsed2, foldersByPath);
}

function buildResult(bookmark, matchedPath, parsed, foldersByPath) {
  let matchedFolder = matchedPath ? foldersByPath.get(matchedPath) : null;

  // Filter out no-op moves: if the bookmark is already in the matched folder, treat as no match.
  if (matchedFolder && matchedFolder.id === bookmark.parentId) {
    matchedFolder = null;
    matchedPath = null;
  }

  const suggestedNewFolder =
    matchedFolder || typeof parsed.suggestedNewFolder !== "string"
      ? null
      : parsed.suggestedNewFolder.trim() || null;

  return {
    bookmark,
    matchedFolder: matchedFolder || null,
    matchedPath: matchedPath || null,
    suggestedNewFolder,
    reasoning:
      typeof parsed.reasoning === "string" && parsed.reasoning.trim()
        ? parsed.reasoning.trim()
        : "No reasoning provided."
  };
}

async function handleClassifyBookmarks(payload) {
  if (typeof LanguageModel === "undefined") {
    return {
      success: false,
      error: "Chrome Built-in AI not available. Please use Chrome 138+ with the required flags enabled."
    };
  }

  const bookmarks = Array.isArray(payload?.bookmarks) ? payload.bookmarks : [];
  const folders = Array.isArray(payload?.folders) ? payload.folders : [];

  // Build path-based lookup. Use first-occurrence dedup for same-path folders.
  const seenPaths = new Set();
  const dedupedFolders = folders.filter((f) => {
    if (!f.path || seenPaths.has(f.path)) return false;
    seenPaths.add(f.path);
    return true;
  });
  const folderPaths = dedupedFolders.map((f) => f.path);
  const foldersByPath = new Map(dedupedFolders.map((f) => [f.path, f]));

  // Initialize live job state.
  classifyJob.active = true;
  classifyJob.cancelled = false;
  classifyJob.current = 0;
  classifyJob.total = bookmarks.length;
  classifyJob.results = [];
  classifyJob.bookmarks = bookmarks;
  classifyJob.folders = folders;
  classifyJob.mode = payload?.mode || "unsorted";

  let session;

  try {
    session = await LanguageModel.create({
      initialPrompts: [{ role: "system", content: getSystemPrompt() }],
      monitor(monitor) {
        if (!monitor || typeof monitor.addEventListener !== "function") return;
        monitor.addEventListener("downloadprogress", (event) => {
          const progress = event?.total > 0 ? event.loaded / event.total : 0;
          sendProgress("modelDownloadProgress", { progress });
        });
      }
    });

    for (let i = 0; i < bookmarks.length; i += 1) {
      // Check for cancellation before each bookmark.
      if (classifyJob.cancelled) {
        break;
      }

      const bookmark = bookmarks[i];
      let result;
      try {
        result = await classifySingleBookmark(session, bookmark, folderPaths, foldersByPath);
      } catch (error) {
        console.error("Classification failed for bookmark:", bookmark, error);
        result = {
          bookmark,
          matchedFolder: null,
          matchedPath: null,
          suggestedNewFolder: null,
          reasoning: "Classification failed for this bookmark."
        };
      }

      classifyJob.results.push(result);
      classifyJob.current = i + 1;
      sendProgress("classifyProgress", { current: i + 1, total: bookmarks.length, result });

      // Save incrementally so the popup can recover if closed mid-sort.
      await saveClassificationState(
        classifyJob.results, bookmarks, folders, classifyJob.mode,
        !classifyJob.cancelled && i + 1 < bookmarks.length // still in progress?
      );
    }

    const wasCancelled = classifyJob.cancelled;
    classifyJob.active = false;

    // Final save with inProgress = false.
    await saveClassificationState(
      classifyJob.results, bookmarks, folders, classifyJob.mode, false
    );

    // Notify popup that classification finished (or was stopped).
    sendProgress("classifyComplete", {
      cancelled: wasCancelled,
      total: bookmarks.length,
      classified: classifyJob.results.length
    });

    return { success: true, results: classifyJob.results, cancelled: wasCancelled };
  } catch (error) {
    classifyJob.active = false;
    console.error("Failed to classify bookmarks:", error);
    return {
      success: false,
      error: error?.message || "Unable to classify bookmarks. Ensure AI is available and Chrome flags are enabled."
    };
  } finally {
    if (session && typeof session.destroy === "function") {
      try { session.destroy(); } catch (_) { /* ignore */ }
    }
  }
}

function handleCancelClassification() {
  if (classifyJob.active) {
    classifyJob.cancelled = true;
    return { success: true, message: "Cancellation requested." };
  }
  return { success: true, message: "No active classification to cancel." };
}

function handleGetClassificationStatus() {
  return {
    success: true,
    active: classifyJob.active,
    current: classifyJob.current,
    total: classifyJob.total,
    resultsCount: classifyJob.results.length,
    mode: classifyJob.mode
  };
}

// ---------------------------------------------------------------------------
// Bookmark move / folder create
// ---------------------------------------------------------------------------

async function handleMoveBookmark(payload) {
  const { bookmarkId, targetFolderId } = payload || {};
  if (!bookmarkId || !targetFolderId) {
    return { success: false, error: "Missing bookmarkId or targetFolderId." };
  }
  try {
    await chrome.bookmarks.move(bookmarkId, { parentId: targetFolderId });
    return { success: true };
  } catch (error) {
    return { success: false, error: `Failed to move bookmark: ${error?.message || error}` };
  }
}

async function handleCreateFolderAndMove(payload) {
  const bookmarkId = payload?.bookmarkId;
  const parentId = payload?.parentId || ROOT_BOOKMARKS_BAR_ID;
  const folderName = typeof payload?.folderName === "string" ? payload.folderName.trim() : "";

  if (!bookmarkId || !folderName) {
    return { success: false, error: "Missing bookmarkId or folderName." };
  }

  try {
    const created = await chrome.bookmarks.create({ parentId, title: folderName });
    await chrome.bookmarks.move(bookmarkId, { parentId: created.id });
    return { success: true, folderId: created.id };
  } catch (error) {
    return { success: false, error: `Failed to create folder and move: ${error?.message || error}` };
  }
}

// ---------------------------------------------------------------------------
// State persistence — save/clear classification results for popup resumption
// ---------------------------------------------------------------------------

async function saveClassificationState(results, bookmarks, folders, mode, inProgress) {
  try {
    await chrome.storage.local.set({
      savedResults: results,
      savedBookmarks: bookmarks,
      savedFolders: folders,
      savedMode: mode,
      savedInProgress: !!inProgress,
      savedAt: Date.now()
    });
  } catch (error) {
    console.warn("Failed to save classification state:", error);
  }
}

async function clearClassificationState() {
  try {
    await chrome.storage.local.remove([
      "savedResults", "savedBookmarks", "savedFolders", "savedMode", "savedInProgress", "savedAt"
    ]);
  } catch (error) {
    console.warn("Failed to clear classification state:", error);
  }
}

async function handleGetSavedState() {
  try {
    const data = await chrome.storage.local.get([
      "savedResults", "savedBookmarks", "savedFolders", "savedMode", "savedInProgress", "savedAt"
    ]);
    const hasSavedResults = Array.isArray(data.savedResults);
    const hasSavedBookmarks = Array.isArray(data.savedBookmarks) && data.savedBookmarks.length > 0;
    const hasState = !!data.savedInProgress || hasSavedBookmarks || (hasSavedResults && data.savedResults.length > 0);
    if (hasState) {
      return {
        success: true,
        hasState: true,
        results: hasSavedResults ? data.savedResults : [],
        bookmarks: data.savedBookmarks || [],
        folders: data.savedFolders || [],
        mode: data.savedMode || "unsorted",
        inProgress: !!data.savedInProgress,
        savedAt: data.savedAt || 0
      };
    }
    return { success: true, hasState: false };
  } catch (error) {
    console.warn("Failed to load saved state:", error);
    return { success: true, hasState: false };
  }
}

// ---------------------------------------------------------------------------
// Install event — prompt user to pin the extension
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    // Open a welcome tab that guides the user to pin the extension.
    chrome.tabs.create({
      url: "welcome.html",
      active: true
    });
  }
});

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case "getUnsortedBookmarks":
          sendResponseSafe(sendResponse, await handleGetUnsortedBookmarks());
          break;
        case "getBookmarksInFolders":
          sendResponseSafe(sendResponse, await handleGetBookmarksInFolders(message));
          break;
        case "checkAIAvailability":
          sendResponseSafe(sendResponse, await handleCheckAIAvailability());
          break;
        case "classifyBookmarks":
          sendResponseSafe(sendResponse, await handleClassifyBookmarks(message));
          break;
        case "triggerModelDownload":
          sendResponseSafe(sendResponse, await handleTriggerModelDownload());
          break;
        case "moveBookmark":
          sendResponseSafe(sendResponse, await handleMoveBookmark(message));
          break;
        case "createFolderAndMove":
          sendResponseSafe(sendResponse, await handleCreateFolderAndMove(message));
          break;
        case "getSavedState":
          sendResponseSafe(sendResponse, await handleGetSavedState());
          break;
        case "clearSavedState":
          await clearClassificationState();
          sendResponseSafe(sendResponse, { success: true });
          break;
        case "cancelClassification":
          sendResponseSafe(sendResponse, handleCancelClassification());
          break;
        case "getClassificationStatus":
          sendResponseSafe(sendResponse, handleGetClassificationStatus());
          break;
        default:
          sendResponseSafe(sendResponse, { success: false, error: "Unknown message type." });
          break;
      }
    } catch (error) {
      console.error("Unhandled background error:", error);
      sendResponseSafe(sendResponse, {
        success: false,
        error: error?.message || "Unexpected error in background service worker."
      });
    }
  })();

  return true;
});
