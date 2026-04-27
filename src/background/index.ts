chrome.runtime.onInstalled.addListener(() => {
  console.info('[OpenTeam] extension installed')
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'OPENTEAM_PING') {
    sendResponse({ ok: true, tabId: sender.tab?.id ?? null })
    return true
  }

  return false
})
