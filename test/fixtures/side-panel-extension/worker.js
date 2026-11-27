// What extensions with a side panel usually do: make their toolbar button open it.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => console.error(err))
