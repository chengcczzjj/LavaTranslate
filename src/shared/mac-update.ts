/** Mac packages without Developer ID can download updates, then use Finder to install. */
export function macUpdateText(lang: string, key: 'open' | 'ready' | 'install' | 'auto' | 'missing') {
  const text = {
    open: ['查看更新包', '查看更新套件', 'Show update package'],
    ready: ['更新包已下载。在 Finder 中解压，然后将 LavaTranslate 拖入「应用程序」替换旧版；替换前请退出软件。', '更新套件已下載。在 Finder 中解壓縮，再將 LavaTranslate 拖入「應用程式」取代舊版；取代前請結束軟體。', 'Update downloaded. Unzip it in Finder, then move LavaTranslate into Applications to replace the old app. Quit the app before replacing it.'],
    install: ['更新已下载，请打开更新包完成安装。', '更新已下載，請開啟更新套件完成安裝。', 'Update downloaded. Open the update package to finish installing.'],
    auto: ['自动检查并下载更新，下载后提示你打开更新包安装。', '自動檢查並下載更新，下載後提示你開啟更新套件安裝。', 'Automatically check and download updates, then prompt you to open the package to install.'],
    missing: ['暂未找到 Mac 更新包，请稍后重试或查看发布页。', '暫時找不到 Mac 更新套件，請稍後重試或查看發佈頁。', 'No Mac update package is available yet. Try again later or check the releases page.']
  }
  return text[key][lang === 'zh-Hant' ? 1 : lang.startsWith('zh') ? 0 : 2]
}
