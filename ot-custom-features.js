// ============================================================
// 公司客製化功能模組(選配)
// 這個檔案只放「Orange Tea 自己要用、但不是每家公司都需要」的功能開關。
// 如果之後有別的公司要用這套系統、不需要這些客製功能,部署時直接不要帶這個檔案就好
// (index.html 裡引用它的那行 <script src="ot-custom-features.js"></script> 留著沒關係,
// 瀏覽器抓不到檔案只會在 console 顯示一個 404,不影響其他功能運作,對應的選項/行為
// 會自動變成系統預設值)。
//
// window.FEATURES 用 Object.assign 合併寫入,不要直接整包蓋掉——因為除了這個檔案,
// receipt-scan-features.js 也會寫入同一個 window.FEATURES 物件,兩個檔案不管誰先載入,
// 都要能疊加、不能互相蓋掉對方已經寫好的開關。
//
// 之後如果要再加新的客製功能,一樣在這裡加一個 true/false 開關就好,
// 主程式那邊用 hasFeature('新開關名稱') 判斷。
// ============================================================
window.FEATURES = window.FEATURES || {};
Object.assign(window.FEATURES, {
  // 商品編輯畫面裡的「不顯示於已完成訂單匯出」開關(含「整個家族都不顯示」/
  // 「僅顯示切換的批量商品數量」兩個子選項)
  hideFromCompletedExport: true,

  // 系統設置 → Stock Location → 列印:「Picking Slip 顯示 Stock Location」開關
  // (含多位置時列印前跳出視窗選擇要從哪裡拿貨)
  stockLocationPickingSlipPrint: true,

  // 系統設置 →「已完成訂單匯出格式」選項(僅匯出有紀錄的商品 / 匯出全部商品)
  completedExportFormatOption: true,

  // Picking Slip 上的「箱數參考」欄(數量參考欄):把訂貨數量換算成幾箱+剩餘幾件,
  // 給揀貨的人參考用
  pickingSlipQtyReference: true
});
