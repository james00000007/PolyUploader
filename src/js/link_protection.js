const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58_encode(bytes) {
    const digits = [0];
    for (const byte of bytes) {
        let carry = byte;
        for (let i = 0; i < digits.length; i++) {
            carry += digits[i] << 8;
            digits[i] = carry % 58;
            carry = Math.floor(carry / 58);
        }
        while (carry > 0) {
            digits.push(carry % 58);
            carry = Math.floor(carry / 58);
        }
    }
    let leading_zeros = '';
    for (const byte of bytes) {
        if (byte !== 0) break;
        leading_zeros += BASE58_ALPHABET[0];
    }
    return leading_zeros + digits.reverse().map(d => BASE58_ALPHABET[d]).join('');
}

function bytes_to_base64(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function format_paste_content(links, filename, upload_date) {
    const separator = '---------------------------------------------';
    const date_str = upload_date
        ? new Date(upload_date).toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).replace(',', '')
        : new Date().toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).replace(',', '');
    return [
        '~ Information ~',
        `Uploaded filename.....: ${filename || 'Unknown'}`,
        `Link creation date....: ${date_str}`,
        '',
        '',
        '~ Links ~',
        separator,
        links.trim(),
        separator,
        '',
        'Created with PolyUploader'
    ].join('\n');
}

async function get_best_expire(instance_url, cors_proxy) {
    const priority = ['never', '1year', '1month', '1week', '1day', '1hour', '10min', '5min'];
    try {
        const response = await fetch(cors_proxy + instance_url);
        const html = await response.text();
        const matches = html.match(/value="(5min|10min|1hour|1day|1week|1month|1year|never)"/g);
        if (matches && matches.length > 0) {
            const available = matches.map(m => m.match(/value="([^"]+)"/)[1]);
            for (const expire of priority) {
                if (available.includes(expire)) return expire;
            }
        }
    } catch (e) {}
    return '1week';
}

export async function create_privatebin_paste(links, instance_url = 'https://privatebin.net/', cors_proxy = '', filename = '', upload_date = null) {
    const text = format_paste_content(links, filename, upload_date);
    const expire = await get_best_expire(instance_url, cors_proxy);
    const key_bytes = crypto.getRandomValues(new Uint8Array(32));
    const salt = crypto.getRandomValues(new Uint8Array(8));
    const iv = crypto.getRandomValues(new Uint8Array(16));

    const key_material = await crypto.subtle.importKey('raw', key_bytes, { name: 'PBKDF2' }, false, ['deriveKey']);
    const derived_key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
        key_material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt']
    );

    const adata = [
        [bytes_to_base64(iv), bytes_to_base64(salt), 310000, 256, 128, 'aes', 'gcm', 'none'],
        'plaintext', 0, 0
    ];

    const paste_bytes = new TextEncoder().encode(JSON.stringify({ paste: text }));
    const adata_bytes = new TextEncoder().encode(JSON.stringify(adata));
    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: adata_bytes, tagLength: 128 },
        derived_key,
        paste_bytes
    );

    const response = await fetch(cors_proxy + instance_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'JSONHttpRequest' },
        body: JSON.stringify({ v: 2, adata, meta: { expire }, ct: bytes_to_base64(new Uint8Array(ciphertext)) })
    });

    const result = await response.json();
    if (result.status !== 0) throw new Error(result.message || 'PrivateBin error');

    return {
        url: `${instance_url}?${result.id}#${base58_encode(key_bytes)}`,
        id: result.id,
        deletetoken: result.deletetoken,
        expire,
        instance_url
    };
}

export async function create_cryptgeon_note(links, cors_proxy = '', filename = '', upload_date = null) {
    const text = format_paste_content(links, filename, upload_date);

    const key = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const alg = 'AES-GCM';

    const key_obj = await crypto.subtle.importKey('raw', key, alg, false, ['encrypt']);
    const encrypted_buf = await crypto.subtle.encrypt({ name: alg, iv }, key_obj, new TextEncoder().encode(text));
    const ciphertext = new Uint8Array(encrypted_buf);

    const alg_bytes = new TextEncoder().encode(alg);
    const to_b64 = b => { let s = ''; for (let i = 0; i < b.byteLength; i++) s += String.fromCharCode(b[i]); return btoa(s); };
    const contents = [alg_bytes, iv, ciphertext].map(to_b64).join('--');

    const response = await fetch(cors_proxy + 'https://cryptgeon.org/api/notes/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents, expiration: 360, meta: '{"type":"text"}' })
    });

    if (!response.ok) throw new Error(`Cryptgeon HTTP ${response.status}`);
    const result = await response.json();
    if (!result.id) throw new Error('Cryptgeon: missing id in response');

    const key_hex = Array.from(key).map(b => b.toString(16).padStart(2, '0')).join('');
    return { url: `https://cryptgeon.org/note/${result.id}#${key_hex}`, id: result.id };
}

export async function create_safelinking_package(links, cors_proxy = '', filename = '', upload_date = null) {
    const params = new URLSearchParams();
    params.append('links-to-protect', links.trim());
    params.append('enable-captcha', 'no');
    params.append('output', 'json');
    if (filename) params.append('title', filename);
    params.append('provider-name', 'PolyUploader');
    params.append('provider-url', 'https://polyuploader.vercel.app');

    const response = await fetch(cors_proxy + 'https://safelinking.net/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });

    if (!response.ok) throw new Error(`SafeLinking HTTP ${response.status}`);
    const result = await response.json();
    if (!result.p_links) throw new Error('SafeLinking: missing p_links in response');

    return {
        url: result.p_links.trim()
    };
}

export async function create_pastesdev_paste(links, cors_proxy = '', filename = '', upload_date = null) {
    const text = format_paste_content(links, filename, upload_date);

    const response = await fetch(cors_proxy + 'https://api.pastes.dev/post', {
        method: 'POST',
        headers: {
            'Content-Type': 'text/plain',
            'User-Agent': 'PolyUploader (polyuploader.vercel.app)'
        },
        body: text
    });

    if (!response.ok) throw new Error(`pastes.dev HTTP ${response.status}`);
    const result = await response.json();
    if (!result.key) throw new Error('pastes.dev: missing key in response');

    return { url: `https://pastes.dev/${result.key}` };
}

export async function create_katbin_paste(links, cors_proxy = '', filename = '', upload_date = null) {
    const text = format_paste_content(links, filename, upload_date);

    const response = await fetch(cors_proxy + 'https://katb.in/api/paste', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paste: { content: text } })
    });

    if (!response.ok) throw new Error(`Katbin HTTP ${response.status}`);
    const result = await response.json();
    if (!result.id) throw new Error('Katbin: missing id in response');

    return { url: `https://katb.in/${result.id}` };
}

export async function create_filecrypt_container(links, api_key, cors_proxy = '', filename = '') {
    if (!api_key) throw new Error('Filecrypt: API key is required');
    const links_arr = links.trim().split('\n').map(l => l.trim()).filter(l => l.length > 0);

    const params = new URLSearchParams();
    params.append('fn', 'containerV2');
    params.append('sub', 'createV2');
    params.append('api_key', api_key);
    params.append('name', filename || 'PolyUploader links');
    params.append('captcha', '0');
    params.append('allow_links', '1');
    links_arr.forEach((link, i) => {
        params.append(`mirror_1[0][${i}]`, link);
    });

    const response = await fetch(cors_proxy + 'https://www.filecrypt.cc/api.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });

    if (!response.ok) throw new Error(`Filecrypt HTTP ${response.status}`);
    const result = await response.json();
    const container_obj = Array.isArray(result.container) ? result.container[0] : result.container;
    if (!container_obj?.link) throw new Error(result.error || 'Filecrypt: missing link in response');

    const container_url = container_obj.link;
    const container_id = container_url.match(/\/Container\/([A-Z0-9]+)\.html/i)?.[1] || '';
    return { url: container_url, container_id };
}


