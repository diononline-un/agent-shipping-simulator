/**
 * ReFlow Parcel Optimizer — Background Service Worker
 * Routes messages between Popup and Content Script.
 */

// Update badge when content script reports item count
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "ITEMS_DETECTED") {
    const count = message.count;
    chrome.action.setBadgeText({
      text: count > 0 ? String(count) : "",
      tabId: sender.tab.id,
    });
    chrome.action.setBadgeBackgroundColor({ color: "#FF6B35" });
  }
});

// Forward messages from Popup → active tab's Content Script
async function forwardToContentScript(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { error: "No active tab" };
  return chrome.tabs.sendMessage(tab.id, message);
}

// Listen for Popup → Background requests that need tab context
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const popupMessages = [
    "GET_ITEMS",
    "START_OPTIMIZATION",
    "CANCEL_OPTIMIZATION",
    "APPLY_SPLIT",
  ];

  if (popupMessages.includes(message.type)) {
    forwardToContentScript(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true; // Keep channel open for async response
  }

  if (message.type === "OPEN_IN_TAB") {
    chrome.storage.session
      .set({ reflow_split: message.itemGroups })
      .then(() => chrome.tabs.create({ url: "https://gtbuy.com/user/warehouse" }))
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});
