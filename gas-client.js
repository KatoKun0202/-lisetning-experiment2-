/* GAS WebアプリへJSONPで読み書きする共通処理 */
window.GAS_WEB_APP_URL = 'PASTE_GAS_WEB_APP_URL_HERE';

window.gasGet = function(action, parameters = {}) {
    return new Promise((resolve, reject) => {
        if (!window.GAS_WEB_APP_URL || window.GAS_WEB_APP_URL.includes('PASTE_')) {
            reject(new Error('GASのウェブアプリURLが未設定です。gas-client.jsを設定してください。'));
            return;
        }
        const callbackName = `gasCallback_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const query = new URLSearchParams({action, ...parameters, callback: callbackName});
        const script = document.createElement('script');
        const timeout = window.setTimeout(() => finish(new Error('GASから応答がありません。')), 20000);
        function finish(error, value) {
            window.clearTimeout(timeout);
            delete window[callbackName];
            script.remove();
            if (error) reject(error);
            else resolve(value);
        }
        window[callbackName] = value => finish(null, value);
        script.onerror = () => finish(new Error('GASへの接続に失敗しました。'));
        script.src = `${window.GAS_WEB_APP_URL}?${query.toString()}`;
        document.head.appendChild(script);
    });
};

window.gasPostAndWait = async function(payload, receiptToken = payload.token) {
    if (!window.GAS_WEB_APP_URL || window.GAS_WEB_APP_URL.includes('PASTE_')) {
        throw new Error('GASのウェブアプリURLが未設定です。gas-client.jsを設定してください。');
    }
    // CORSの事前確認が起きないtext/plainでPOSTし、JSONPの受領確認で保存完了を確かめる。
    await fetch(window.GAS_WEB_APP_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: {'Content-Type': 'text/plain;charset=UTF-8'},
        body: JSON.stringify(payload)
    });
    for (let attempt = 0; attempt < 30; attempt++) {
        const receipt = await window.gasGet('receipt', {token: receiptToken});
        if (receipt.ready) {
            if (!receipt.ok) throw new Error(receipt.error || 'GASで処理できませんでした。');
            return receipt.value;
        }
        await new Promise(resolve => window.setTimeout(resolve, 700));
    }
    throw new Error('保存の確認に時間がかかっています。接続状態を確認して再試行してください。');
};
