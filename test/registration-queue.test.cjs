'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const manifest = require('../plugin.json');

// Load the real plugin with NodeBB services supplied by an in-memory host.
// No running forum, database, phone provider, or development dependencies needed.
async function createHost() {
    const objects = new Map();
    const values = new Map();
    const sets = new Map();
    const db = {
        get: async key => values.get(key),
        set: async (key, value) => values.set(key, value),
        pexpireAt: async () => {},
        delete: async key => { objects.delete(key); values.delete(key); },
        getObject: async key => objects.has(key) ? { ...objects.get(key) } : null,
        setObject: async (key, value) => objects.set(key, { ...objects.get(key), ...value }),
        sortedSetAdd: async (key, score, member) => {
            if (!sets.has(key)) sets.set(key, new Map());
            sets.get(key).set(String(member), Number(score));
        },
        sortedSetScore: async (key, member) => sets.get(key)?.get(String(member)) ?? null,
        sortedSetRemove: async (key, member) => sets.get(key)?.delete(String(member)),
        getSortedSetRange: async key => [...(sets.get(key)?.keys() || [])],
        getSortedSetRevRangeWithScores: async key => [...(sets.get(key)?.entries() || [])]
            .map(([value, score]) => ({ value, score })),
        getObjects: async keys => Promise.all(keys.map(key => db.getObject(key))),
        getObjectsFields: async (keys, fields) => keys.map(key =>
            Object.fromEntries(fields.map(field => [field, objects.get(key)?.[field]]))),
        incrObjectFieldBy: async () => 1,
        incrObjectField: async () => 1,
        setObjectField: async (key, field, value) => db.setObject(key, { [field]: value }),
    };
    const User = {
        setUserFields: async (uid, fields) => db.setObject(`user:${uid}`, fields),
        getUserFields: async uid => db.getObject(`user:${uid}`),
        checkUsernameLength: () => {},
        isDataValid: async () => {},
        hashPassword: async password => password ? `hashed:${password}` : null,
        getUidsFromSet: async () => [],
        getUsersFields: async () => [],
        notifications: { pushCount: () => {} },
    };
    const services = {
        nconf: { get: () => '' },
        './src/database': db,
        './src/user': User,
        './src/meta': { config: {} },
        './src/socket.io/plugins': {},
    };
    const hostRequire = name => require(name);
    hostRequire.main = { require: name => {
        if (!(name in services)) throw new Error(`Unexpected service: ${name}`);
        return services[name];
    } };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../library.js'), 'utf8'),
        { require: hostRequire, module, console, Buffer, URL, setTimeout, clearTimeout },
        { filename: 'library.js' });
    const plugin = module.exports;
    await plugin.init({ router: { get() {}, post() {} }, middleware: { admin: {} } });
    const hooks = {
        fire: async (name, data) => {
            for (const hook of manifest.hooks.filter(hook => hook.hook === name)) {
                data = await plugin[hook.method](data) || data;
            }
            return data;
        },
    };
    return { plugin, db, User, hooks, objects, services };
}

test('registers persistence on the approval queue hook', () => {
    assert.ok(manifest.hooks.some(hook => hook.hook === 'filter:user.addToApprovalQueue' &&
        hook.method === 'addPendingApprovalPhone'));
    assert.ok(!manifest.hooks.some(hook => hook.hook === 'filter:register.complete'));
});

test('verified phone survives queue storage and approval after verification expires', async () => {
    const { plugin, db, User, hooks } = await createHost();
    await plugin.markPhoneAsVerified('050-1234567');
    const userData = { username: 'pending', phoneNumber: '050-1234567' };
    const queued = await hooks.fire('filter:user.addToApprovalQueue', {
        data: { username: userData.username, hashedPassword: 'hash', _opts: '{}' }, userData,
    });
    assert.equal(queued.data.phoneNumber, '0501234567');
    assert.equal(queued.data.hashedPassword, 'hash');
    await db.setObject('registration:queue:name:pending', queued.data);
    await plugin.clearVerifiedPhone('0501234567');
    const stored = await db.getObject('registration:queue:name:pending');
    await hooks.fire('action:user.create', { user: { uid: 42 }, data: stored });
    const user = await User.getUserFields(42);
    assert.equal(user.phoneNumber, '0501234567');
    assert.equal(user.phoneVerified, 1);
    assert.ok(user.phoneVerifiedAt > 0);
    assert.equal(await plugin.findUserByPhone('0501234567'), 42);
});

test('queue entries without a phone retain their existing fields', async () => {
    const { hooks } = await createHost();
    const data = { data: { username: 'sso', hashedPassword: 'hash' }, userData: { username: 'sso' } };
    assert.equal(await hooks.fire('filter:user.addToApprovalQueue', data), data);
    assert.deepEqual(data.data, { username: 'sso', hashedPassword: 'hash' });
});

test('queue display hides phone numbers without changing stored registration data', async () => {
    const { db, hooks } = await createHost();
    const storedUser = { username: 'pending', phoneNumber: '0501234567', email: 'test@example.com' };
    await db.setObject('registration:queue:name:pending', storedUser);
    const result = await hooks.fire('filter:user.getRegistrationQueue', { users: [storedUser] });
    assert.equal(result.users[0].phoneNumber, undefined);
    assert.equal(result.users[0].username, 'pending');
    assert.equal(result.users[0].email, 'test@example.com');
    assert.equal(storedUser.phoneNumber, '0501234567');
    assert.equal((await db.getObject('registration:queue:name:pending')).phoneNumber, '0501234567');
    assert.deepEqual((await hooks.fire('filter:user.getRegistrationQueue', { users: [] })).users, []);
});

test('unverified or malformed phones cannot be persisted as verified registrations', async () => {
    const { plugin, hooks } = await createHost();
    for (const phoneNumber of ['0501234567', 'garbage', { phone: '0501234567' }]) {
        const data = { data: { username: 'pending' }, userData: { phoneNumber } };
        await assert.rejects(hooks.fire('filter:user.addToApprovalQueue', data), /registration-unverified/);
        assert.equal(data.data.phoneNumber, undefined);
    }
    await plugin.markPhoneAsVerified('invalid');
    await assert.rejects(hooks.fire('filter:user.addToApprovalQueue', {
        data: {}, userData: { phoneNumber: 'invalid' },
    }), /registration-unverified/);
});

test('ordinary user creation still saves the phone and clears temporary verification', async () => {
    const { plugin, User, hooks } = await createHost();
    await plugin.markPhoneAsVerified('0521234567');
    await hooks.fire('action:user.create', { user: { uid: 7 }, data: { phoneNumber: '0521234567' } });
    assert.equal((await User.getUserFields(7)).phoneVerified, 1);
    assert.equal(await plugin.isPhoneVerified('0521234567'), false);
});

// Optional integration against an actual NodeBB checkout, using its unmodified
// approval module and the same hook dispatch. CI can run the portable tests above.
test('NodeBB approval queue -> acceptRegistration preserves verified phone privately', {
    skip: !process.env.NODEBB_SOURCE,
}, async () => {
    const { plugin, db, User, hooks, objects, services } = await createHost();
    services['./src/meta'].config.registrationApprovalType = 'admin-approval';
    const stubs = {
        validator: { escape: value => value },
        cron: { CronJob: class {} },
        winston: { error() {} }, '../database': db, '../meta': services['./src/meta'],
        '../emailer': { send: async () => {} },
        '../notifications': { create: async () => ({}), pushGroup: async () => {}, rescind: async () => {} },
        '../groups': { getMembers: async () => [] },
        '../utils': { toISOString: value => new Date(value).toISOString() },
        '../password': {},
        '../slugify': value => value.toLowerCase(), '../plugins': { hooks },
        '../translator': { compile: value => value, escape: value => value },
    };
    const module = { exports: {} };
    const filename = path.join(process.env.NODEBB_SOURCE, 'src/user/approval.js');
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        require: name => {
            if (!(name in stubs)) throw new Error(`Unexpected import: ${name}`);
            return stubs[name];
        }, module, console,
    }, { filename });
    module.exports(User);
    User.create = async data => {
        await hooks.fire('action:user.create', { user: { uid: 42 }, data });
        return 42;
    };
    await plugin.markPhoneAsVerified('054-1234567');
    const registration = {
        username: 'pending', email: 'pending@example.com', password: 'password', phoneNumber: '054-1234567',
        ip: '127.0.0.1',
    };
    if (User.createOrQueue) {
        const result = await User.createOrQueue({ ip: registration.ip }, registration);
        assert.equal(result.queued, true);
    } else {
        // NodeBB 3.x queues from its authentication controller directly.
        await User.addToApprovalQueue(registration);
    }
    assert.equal(objects.get('registration:queue:name:pending').phoneNumber, '0541234567');
    const queueView = await User.getRegistrationQueue(0, -1);
    assert.equal(queueView.length, 1);
    assert.equal(queueView[0].phoneNumber, undefined);
    assert.equal(objects.get('registration:queue:name:pending').phoneNumber, '0541234567');
    await plugin.clearVerifiedPhone('0541234567');
    assert.equal(await User.acceptRegistration('pending'), 42);
    assert.equal(objects.has('registration:queue:name:pending'), false);
    const user = await User.getUserFields(42);
    assert.equal(user.phoneNumber, '0541234567');
    assert.equal(user.phoneVerified, 1);
    assert.equal(await plugin.findUserByPhone('0541234567'), 42);
});
