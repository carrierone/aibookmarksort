# AI Bookmark Sorter

A Chrome extension that uses Chrome's built-in AI (Gemini Nano) to automatically sort your bookmarks into the best-fitting folder.

## Features

- **Auto-classify unsorted bookmarks** - Bookmarks sitting loose in your Bookmarks Bar or Other Bookmarks are analyzed and matched to existing folders
- **Subfolder-aware** - Picks the most specific subfolder path (e.g. `Tech > JavaScript > Frameworks`) instead of just top-level folders
- **Webpage content fallback** - When the title and URL aren't enough to categorize a bookmark, the extension fetches the actual page and uses its content for better classification
- **Folder re-sort** - Select any existing folders to recategorize their contents across your entire folder structure
- **New folder suggestions** - If no existing folder is a good fit, the AI suggests a new folder name that you can accept or edit
- **Review before applying** - All suggested moves are shown for review with confidence badges and AI reasoning before anything is moved

## Prerequisites

- **Chrome 138+** on Windows, macOS, or Linux
- **22 GB+ free disk space** (for the Gemini Nano model download)
- **GPU with >4 GB VRAM**, or **16 GB RAM with 4+ CPU cores**

## Setup

### 1. Enable Chrome flags

Open each of these URLs in Chrome and set them to **Enabled**, then restart Chrome:

```
chrome://flags/#optimization-guide-on-device-model
chrome://flags/#prompt-api-for-gemini-nano-multimodal-input
```

### 2. Wait for Gemini Nano to download

After enabling the flags and restarting, Chrome will download the Gemini Nano model in the background (~22 GB). You can check the download status at:

```
chrome://components
```

Look for **Optimization Guide On Device Model** and make sure it has a version number (not `0.0.0.0`). You can click "Check for update" to trigger the download if it hasn't started.

### 3. Install the extension

**Option A: Download the release (easiest)**

1. Download `aibookmarksort-v1.0.zip` from the [latest release](https://github.com/carrierone/aibookmarksort/releases/latest)
2. Extract the zip file
3. Open `chrome://extensions` in Chrome
4. Enable **Developer mode** (toggle in the top right)
5. Click **Load unpacked**
6. Select the extracted `aibookmarksort` folder

**Option B: Clone the repository**

1. Clone the repo:
   ```bash
   git clone https://github.com/carrierone/aibookmarksort.git
   ```
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (toggle in the top right)
4. Click **Load unpacked**
5. Select the `aibookmarksort` folder

The extension icon will appear in your toolbar.

## Usage

### Sort unsorted bookmarks

1. Click the extension icon in the toolbar
2. The popup shows how many unsorted bookmarks were found (bookmarks sitting directly in your Bookmarks Bar or Other Bookmarks, not inside any subfolder)
3. Click **Sort Unsorted Bookmarks**
4. Wait while Gemini Nano classifies each bookmark - a progress bar shows the current status
5. Review the results:
   - Each card shows the bookmark title, URL, suggested destination folder (with full path), a confidence badge (High/Medium/Low), and the AI's reasoning
   - For bookmarks where no folder fits, the AI suggests a new folder name in an editable text field
   - Uncheck any moves you don't want
6. Click **Apply All** or **Apply Selected** to move the bookmarks

### Re-sort an existing folder

1. Click the extension icon
2. Click **Re-sort a Folder**
3. A hierarchical folder picker appears - check the folders whose bookmarks you want to recategorize
4. Click **Re-sort Selected**
5. The AI analyzes every bookmark in the selected folders against your full folder tree and suggests better placements
6. Review and apply as above

### How classification works

1. **First pass** - The AI analyzes the bookmark's title and URL against all your folder paths
2. **Second pass (automatic)** - If the first pass doesn't find a confident match, the extension fetches the actual webpage, extracts its text content, and re-prompts the AI with the additional context
3. **No-op filtering** - If the AI suggests moving a bookmark to the folder it's already in (during re-sort), that result is automatically filtered out

## File structure

```
aibookmarksort/
  manifest.json      # Extension manifest (Manifest V3)
  background.js      # Service worker: AI classification, bookmark operations, page fetching
  popup.html         # Extension popup markup
  popup.css          # Popup styling
  popup.js           # Popup UI logic and state management
  icons/
    icon16.png       # Toolbar icon
    icon48.png       # Extension page icon
    icon128.png      # Chrome Web Store icon
```

## Permissions

| Permission | Reason |
|---|---|
| `bookmarks` | Read and move bookmarks, create folders |
| `storage` | Persist extension state |
| `<all_urls>` (host) | Fetch webpage content for bookmarks that can't be classified by title/URL alone |

## Troubleshooting

**"Setup Required" error when opening the extension**
- Make sure both Chrome flags are enabled (see Setup step 1)
- Make sure you're on Chrome 138 or newer (`chrome://version`)
- Check that the Gemini Nano model has finished downloading at `chrome://components`

**Classification is slow**
- Each bookmark requires an AI prompt (and a second prompt + page fetch if the first pass is ambiguous). With many bookmarks this takes time. The progress bar shows real-time status.

**"No unsorted bookmarks found"**
- All your bookmarks are already inside subfolders. Use the **Re-sort a Folder** feature to recategorize bookmarks within specific folders.

**Webpage content fetch fails for some bookmarks**
- Some sites block requests, require authentication, or are no longer online. The extension gracefully falls back to title+URL classification when a page can't be fetched.

## License

MIT
