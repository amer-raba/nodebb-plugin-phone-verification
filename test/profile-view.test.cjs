'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the complete AMD client against the small part of the DOM it uses for
// profile rendering. Requests and translation remain independently controllable.
function createProfile(options = {}) {
    const requests = [];
    const translations = [];
    const inserted = [];
    const handlers = {};
    const ids = new Set();
    const document = {};
    const ajaxify = { data: { userslug: 'alice', template: { name: 'account/profile' } } };
    const exists = selector => {
        if (selector.includes('#user-phone-')) return selector.split(',').some(id => ids.has(id.trim()));
        if (selector === '#content a[href^="mailto:"]') return options.email !== false;
        if (selector === '.account-stats .row') return options.stats !== false;
        if (selector === '.profile-meta') return !!options.meta;
        if (selector === '.fullname') return !!options.fullname;
        return false;
    };
    function $(selector) {
        const collection = {
            length: Number(exists(typeof selector === 'string' ? selector : 'document')),
            first: () => collection,
            on: () => collection,
            after: html => insert('after', html),
            append: html => insert('append', html),
        };
        function insert(method, html) {
            inserted.push({ selector, method, html });
            for (const match of html.matchAll(/id="([^"]+)"/g)) ids.add('#' + match[1]);
        }
        return collection;
    }
    $.getJSON = (url, callback) => { requests.push({ url, callback }); };
    const translator = {
        translate: html => new Promise(resolve => translations.push(() => resolve(html))),
        compile: key => '[[' + key + ']]',
    };
    let plugin;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../static/lib/main.js'), 'utf8'), {
        define: (name, dependencies, factory) => {
            plugin = factory({ on: (name, callback) => { handlers[name] = callback; } }, translator, {});
        },
        $, document, ajaxify, config: { relative_path: '/forum' }, console,
    }, { filename: 'static/lib/main.js' });
    return {
        requests, translations, inserted, plugin, ajaxify,
        navigate: (slug = 'bob') => {
            ajaxify.data = { userslug: slug, template: { name: 'account/profile' } };
            ids.clear();
            handlers['action:ajaxify.end']();
        },
        respond: (response, index = 0) => requests[index].callback(response),
        translate: async () => {
            translations.splice(0).forEach(resolve => resolve());
            await Promise.resolve();
        },
    };
}

const phone = { success: true, phone: '0501234567', phoneVerified: true, isOwner: true };

test('renders authorized phone next to profile email with privacy label', async () => {
    const host = createProfile();
    assert.equal(host.requests[0].url, '/forum/api/user/alice/phone');
    host.respond(phone);
    await host.translate();
    assert.equal(host.inserted.length, 1);
    const result = host.inserted[0];
    assert.equal(result.selector, '#content a[href^="mailto:"]');
    assert.equal(result.method, 'after');
    assert.match(result.html, /id="user-phone-inline"/);
    assert.match(result.html, /0501234567/);
    assert.match(result.html, /label.hidden/);
});

test('unverified phone keeps warning and escaped edit URL', async () => {
    const host = createProfile();
    host.respond({ ...phone, phoneVerified: false, isOwner: false });
    await host.translate();
    assert.match(host.inserted[0].html, /phone-goto-edit/);
    assert.match(host.inserted[0].html, /data-edit-url="\/forum\/user\/alice\/edit"/);
    assert.doesNotMatch(host.inserted[0].html, /label.hidden/);
});

for (const [name, options, selector, method] of [
    ['statistics', { email: false }, '.account-stats .row', 'append'],
    ['metadata', { email: false, stats: false, meta: true }, '.profile-meta', 'append'],
    ['name', { email: false, stats: false, fullname: true }, '.fullname', 'after'],
]) {
    test(`keeps ${name} fallback when profile has no email`, async () => {
        const host = createProfile(options);
        host.respond(phone);
        await host.translate();
        assert.equal(host.inserted.length, 1);
        assert.equal(host.inserted[0].selector, selector);
        assert.equal(host.inserted[0].method, method);
        assert.match(host.inserted[0].html, /id="user-phone-stat-item"/);
    });
}

test('hidden, missing, or failed API responses render nothing', async () => {
    for (const response of [{ success: true, phone: null, hidden: true }, { success: false }, { success: true }]) {
        const host = createProfile();
        host.respond(response);
        await host.translate();
        assert.equal(host.inserted.length, 0);
    }
});

test('API phone text is HTML escaped', async () => {
    const host = createProfile();
    host.respond({ ...phone, phone: '<img src=x onerror="alert(1)">&\'' });
    await host.translate();
    assert.doesNotMatch(host.inserted[0].html, /<img/);
    assert.match(host.inserted[0].html, /&lt;img/);
    assert.match(host.inserted[0].html, /&quot;/);
    assert.match(host.inserted[0].html, /&amp;&#39;/);
});

test('concurrent initialization and translation append only once', async () => {
    const host = createProfile();
    host.plugin.init();
    host.respond(phone, 0);
    host.respond(phone, 1);
    await host.translate();
    assert.equal(host.inserted.length, 1);
    host.plugin.init();
    assert.equal(host.requests.length, 2);
});

test('response from previous profile is ignored after navigation', async () => {
    const host = createProfile();
    host.navigate();
    host.respond(phone, 0);
    await host.translate();
    assert.equal(host.inserted.length, 0);
    host.respond({ ...phone, phone: '0521234567' }, 1);
    await host.translate();
    assert.equal(host.inserted.length, 1);
    assert.match(host.inserted[0].html, /0521234567/);
});

for (const email of [true, false]) {
    test(`translation from previous profile is ignored (${email ? 'inline' : 'fallback'})`, async () => {
        const host = createProfile({ email });
        host.respond(phone);
        host.navigate();
        await host.translate();
        assert.equal(host.inserted.length, 0);
    });
}
