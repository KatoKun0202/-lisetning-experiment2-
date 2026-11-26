/** GitHub Pagesの画面から呼び出されるGASの保存・集計API */
const RESPONSE_SHEET_NAME = 'Responses';
const EXPERIMENT_SHEET_NAME = 'Experiments';
const SCRIPT_PROPERTIES = PropertiesService.getScriptProperties();

/** スプレッドシートにバインドした状態で、最初にエディタから一度だけ実行する */
function setup() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('このスクリプトを保存先スプレッドシートにバインドしてから実行してください。');
  SCRIPT_PROPERTIES.setProperty('SPREADSHEET_ID', spreadsheet.getId());
  let responseSheet = spreadsheet.getSheetByName(RESPONSE_SHEET_NAME);
  if (!responseSheet) responseSheet = spreadsheet.insertSheet(RESPONSE_SHEET_NAME);
  if (responseSheet.getLastRow() === 0) {
    responseSheet.appendRow(['experiment_id', 'prefix', 'submitted_at', 'participant_json', 'responses_json']);
    responseSheet.appendRow(['Z000', 'Z', '2026-11-20T09:12:00.000Z',
      JSON.stringify({age: 24, gender: '回答しない'}),
      JSON.stringify([
        {stimulusId: 'Inst_Choose Your Fighter', humanLikeness: 5, confidence: 6, freeResponse: 'リズムの揺れが自然に感じられました。', ranges: [{start: 4.2, end: 6.1}, {start: 12, end: 13.4}]},
        {stimulusId: 'Demo_Track_B', humanLikeness: 2, confidence: 5, freeResponse: '音の強さが均一で、機械的に感じました。', ranges: [{start: 8.5, end: 10}]},
        {stimulusId: 'Demo_Track_C', humanLikeness: 4, confidence: 3, freeResponse: '基準刺激と同じくらいだと思いました。', ranges: []}
      ])
    ]);
  }
  let experimentSheet = spreadsheet.getSheetByName(EXPERIMENT_SHEET_NAME);
  if (!experimentSheet) experimentSheet = spreadsheet.insertSheet(EXPERIMENT_SHEET_NAME);
  if (experimentSheet.getLastRow() === 0) experimentSheet.appendRow(['prefix', 'name', 'config_json', 'created_at']);

  let folderId = SCRIPT_PROPERTIES.getProperty('AUDIO_FOLDER_ID');
  if (!folderId) {
    const folder = DriveApp.createFolder('Listening Experiment Audio');
    folderId = folder.getId();
    SCRIPT_PROPERTIES.setProperty('AUDIO_FOLDER_ID', folderId);
  }
  initializeCounters_(responseSheet);
  return `Setup complete: ${spreadsheet.getName()}`;
}

/** 最初の試行番号を保存済み回答から復元する */
function initializeCounters_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues().flat();
  const largest = {};
  ids.forEach(id => {
    const match = /^([A-Z])(\d{3})$/.exec(id);
    if (match) largest[match[1]] = Math.max(largest[match[1]] ?? -1, Number(match[2]));
  });
  Object.keys(largest).forEach(prefix => SCRIPT_PROPERTIES.setProperty(`counter:${prefix}`, String(largest[prefix])));
}

function getSpreadsheet_() {
  const id = SCRIPT_PROPERTIES.getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('setup()を先に実行してください。');
  return SpreadsheetApp.openById(id);
}

function output_(callback, data) {
  const safeCallback = /^[A-Za-z_$][\w$]*$/.test(callback || '') ? callback : 'callback';
  return ContentService.createTextOutput(`${safeCallback}(${JSON.stringify(data)});`)
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function doGet(e) {
  const params = (e && e.parameter) || {};
  const callback = params.callback || 'callback';
  try {
    const action = params.action || '';
    if (action === 'receipt') {
      const raw = SCRIPT_PROPERTIES.getProperty(`receipt:${params.token || ''}`);
      return output_(callback, raw ? {ready: true, ...JSON.parse(raw)} : {ready: false});
    }
    if (action === 'config') {
      const config = findExperiment_(params.prefix || '');
      return output_(callback, config ? {ok: true, config} : {ok: false, error: '実験設定が見つかりません。'});
    }
    if (action === 'results') {
      return output_(callback, {ok: true, attempts: readResults_()});
    }
    return output_(callback, {ok: false, error: 'Unknown action'});
  } catch (error) {
    return output_(callback, {ok: false, error: error.message});
  }
}

function doPost(e) {
  let payload = {};
  try {
    payload = JSON.parse(e.postData.contents || '{}');
    const token = String(payload.token || '');
    if (!/^[A-Za-z0-9_-]{12,80}$/.test(token)) throw new Error('要求IDが正しくありません。');
    const cached = SCRIPT_PROPERTIES.getProperty(`receipt:${token}`);
    if (cached) return ContentService.createTextOutput('accepted');
    let result;
    if (payload.action === 'start') result = startAttempt_(payload);
    else if (payload.action === 'complete') result = completeAttempt_(payload);
    else if (payload.action === 'upload') result = uploadAudio_(payload);
    else if (payload.action === 'create') result = createExperiment_(payload);
    else throw new Error('不明な処理です。');
    SCRIPT_PROPERTIES.setProperty(`receipt:${token}`, JSON.stringify({ok: true, value: result}));
  } catch (error) {
    const token = String(payload.token || '');
    if (/^[A-Za-z0-9_-]{12,80}$/.test(token)) {
      SCRIPT_PROPERTIES.setProperty(`receipt:${token}`, JSON.stringify({ok: false, error: error.message}));
    }
  }
  return ContentService.createTextOutput('accepted');
}

function startAttempt_(payload) {
  const prefix = String(payload.prefix || '').toUpperCase();
  if (!/^[A-Z]$/.test(prefix)) throw new Error('実験IDの先頭は英字1文字にしてください。');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const number = Number(SCRIPT_PROPERTIES.getProperty(`counter:${prefix}`) ?? -1) + 1;
    if (number > 999) throw new Error('この実験IDの番号は999まで使用されています。');
    SCRIPT_PROPERTIES.setProperty(`counter:${prefix}`, String(number));
    return {experimentId: `${prefix}${String(number).padStart(3, '0')}`};
  } finally {
    lock.releaseLock();
  }
}

function completeAttempt_(payload) {
  const experimentId = String(payload.experimentId || '');
  if (!/^[A-Z]\d{3}$/.test(experimentId) || !Array.isArray(payload.responses)) throw new Error('回答データが正しくありません。');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getSpreadsheet_().getSheetByName(RESPONSE_SHEET_NAME);
    if (!sheet) throw new Error('回答シートがありません。setup()を実行してください。');
    const lastRow = sheet.getLastRow();
    if (lastRow >= 2) {
      const matches = sheet.getRange(2, 1, lastRow - 1, 1).createTextFinder(experimentId).matchEntireCell(true).findNext();
      if (matches) return {saved: true, duplicate: true};
    }
    // 参加者の全回答を1行にまとめて追加し、途中保存にならない形にする。
    sheet.appendRow([
      experimentId, experimentId.charAt(0), new Date().toISOString(),
      JSON.stringify(payload.participantInfo || {}), JSON.stringify(payload.responses)
    ]);
    SpreadsheetApp.flush();
    return {saved: true};
  } finally {
    lock.releaseLock();
  }
}

function uploadAudio_(payload) {
  const name = String(payload.name || 'audio.wav').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
  const mimeType = String(payload.mimeType || 'audio/wav');
  const base64 = String(payload.base64 || '');
  if (!name.toLowerCase().endsWith('.wav') || !base64 || base64.length > 32 * 1024 * 1024) {
    throw new Error('WAV音源を1曲ずつ、24MB以内でアップロードしてください。');
  }
  const bytes = Utilities.base64Decode(base64);
  if (bytes.length < 12 || String.fromCharCode(...bytes.slice(0, 4)) !== 'RIFF' || String.fromCharCode(...bytes.slice(8, 12)) !== 'WAVE') {
    throw new Error(`${name} は有効なWAVファイルではありません。`);
  }
  const folderId = SCRIPT_PROPERTIES.getProperty('AUDIO_FOLDER_ID');
  if (!folderId) throw new Error('setup()を先に実行してください。');
  const blob = Utilities.newBlob(bytes, mimeType, name);
  const file = DriveApp.getFolderById(folderId).createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return {fileId: file.getId(), name, url: `https://drive.google.com/uc?export=download&id=${file.getId()}`};
}

function createExperiment_(payload) {
  const prefix = String(payload.prefix || '').toUpperCase();
  if (!/^[A-Z]$/.test(prefix)) throw new Error('実験IDの先頭は英字1文字にしてください。');
  if (!payload.baseline || !Array.isArray(payload.targets) || !payload.targets.length) throw new Error('基準刺激1曲と評価対象1曲以上が必要です。');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = getSpreadsheet_().getSheetByName(EXPERIMENT_SHEET_NAME);
    if (sheet.getLastRow() >= 2) {
      const existing = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).createTextFinder(prefix).matchEntireCell(true).findNext();
      if (existing) throw new Error(`実験ID ${prefix} はすでに使われています。別の英字を指定してください。`);
    }
    const config = {
      prefix,
      name: String(payload.name || `実験${prefix}`).slice(0, 100),
      baseline: payload.baseline,
      targets: payload.targets
    };
    sheet.appendRow([prefix, config.name, JSON.stringify(config), new Date().toISOString()]);
    SpreadsheetApp.flush();
    return {prefix, targetCount: config.targets.length};
  } finally {
    lock.releaseLock();
  }
}

function findExperiment_(prefix) {
  const sheet = getSpreadsheet_().getSheetByName(EXPERIMENT_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return null;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues();
  for (const row of values) if (String(row[0]) === String(prefix)) return JSON.parse(row[2]);
  return null;
}

function readResults_() {
  const sheet = getSpreadsheet_().getSheetByName(RESPONSE_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues().map(row => ({
    experimentId: String(row[0]), prefix: String(row[1]), status: 'completed', createdAt: row[2], completedAt: row[2],
    participantInfo: JSON.parse(row[3] || '{}'), responses: JSON.parse(row[4] || '[]')
  }));
}
