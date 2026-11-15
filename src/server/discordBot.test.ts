import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createManagementRouter, VmLifecycleAdapter } from './managementApi';
import { RegistryStore } from './registryStore';
import { AUTHORIZED_ADMIN_ID } from './botAuth';
import { getDefaultProvisioningPassword } from './credentialPolicy';
import { VmRecord } from './vmManager';

function createBotTestVmAdapter(): VmLifecycleAdapter {
  const vms = new Map<string, VmRecord>();
  let seq = 1;
  return {
    async createVm(options) {
      const id = options.id || `vm-${options.osId}-bot${seq++}`;
      const rec: VmRecord = {
        id,
        name: options.name || `VM ${id}`,
        osId: options.osId,
        osName: options.osId === 'windows-7' ? 'Windows 7' : 'Debian 12',
        version: '12',
        imageId: 'test.iso',
        cores: options.cores || 2,
        memoryMb: options.memoryMb || 2048,
        diskGb: options.diskGb || 40,
        username: 'Administrator',
        password: '[POLICY_MANAGED]',
        localPort: 3400 + seq,
        ipAddress: '159.223.110.159',
        publicEndpoint: `159.223.110.159:${3400 + seq}`,
        hypervisorId: 'qemu-tcg-x86_64',
        networkConfig: {
          interfaceType: 'VirtIO-net',
          localPort: 3400 + seq,
          guestPort: 3389,
          natForwarding: true,
        },
        status: 'Ready',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isPolicyManaged: true,
      };
      vms.set(id, rec);
      return rec;
    },
    getVm: (id) => vms.get(id),
    startVm: async (id) => vms.has(id),
    shutdownVm: async (id) => vms.has(id),
    restartVm: async (id) => vms.has(id),
    stopVm: async (id) => vms.has(id),
    forceStopVm: async (id) => vms.has(id),
    deleteVm: async (id) => vms.delete(id),
    rebuildVm: async (id) => vms.get(id) || null,
    reloadIp: async (id) => {
      const vm = id ? vms.get(id) : undefined;
      if (!vm) throw new Error('Not found');
      const oldEndpoint = vm.publicEndpoint;
      vm.localPort += 1;
      vm.publicEndpoint = `159.223.110.159:${vm.localPort}`;
      return { success: true, vm, oldEndpoint, newEndpoint: vm.publicEndpoint, port: vm.localPort };
    },
    renameVm: (id, newName) => {
      const vm = vms.get(id);
      if (vm) vm.name = newName;
      return vm;
    },
  };
}

interface CapturedPayload {
  content?: unknown;
  embeds?: Array<{ toJSON?: () => Record<string, unknown> }>;
  flags?: number;
}

function createMockInteraction(params: {
  commandName: string;
  userId: string;
  username?: string;
  strings?: Record<string, string>;
  integers?: Record<string, number>;
  booleans?: Record<string, boolean>;
  users?: Record<string, { id: string; username: string }>;
  subcommand?: string;
  isDiscordAdmin?: boolean;
}) {
  const defaultPassword = getDefaultProvisioningPassword();
  const captured: CapturedPayload[] = [];
  let deferred = false;
  let replied = false;

  const assertEmbedOnly = (payload: CapturedPayload) => {
    assert.equal(payload.content, undefined, `Command /${params.commandName} MUST NOT send plain-text content`);
    assert.ok(Array.isArray(payload.embeds) && payload.embeds.length > 0, `Command /${params.commandName} MUST send embeds`);
    const jsonStr = JSON.stringify(payload.embeds.map((e) => (e.toJSON ? e.toJSON() : e)));
    assert.equal(jsonStr.includes(defaultPassword), false, 'Discord Embed MUST NEVER expose password');
  };

  const interaction = {
    commandName: params.commandName,
    user: {
      id: params.userId,
      username: params.username || `Tester-${params.userId.slice(-4)}`,
    },
    memberPermissions: {
      has: () => Boolean(params.isDiscordAdmin),
    },
    get deferred() {
      return deferred;
    },
    get replied() {
      return replied;
    },
    isChatInputCommand: () => true,
    options: {
      getString: (name: string, required?: boolean) => {
        const val = params.strings?.[name] ?? null;
        if (required && val === null) throw new Error(`Missing required string ${name}`);
        return val;
      },
      getInteger: (name: string, required?: boolean) => {
        const val = params.integers?.[name] ?? null;
        if (required && val === null) throw new Error(`Missing required integer ${name}`);
        return val;
      },
      getBoolean: (name: string) => params.booleans?.[name] ?? null,
      getUser: (name: string, required?: boolean) => {
        const val = params.users?.[name] ?? null;
        if (required && val === null) throw new Error(`Missing required user ${name}`);
        return val;
      },
      getSubcommand: () => params.subcommand || '',
    },
    deferReply: async () => {
      deferred = true;
    },
    reply: async (payload: CapturedPayload) => {
      assertEmbedOnly(payload);
      replied = true;
      captured.push(payload);
      return payload;
    },
    editReply: async (payload: CapturedPayload) => {
      assertEmbedOnly(payload);
      replied = true;
      captured.push(payload);
      return payload;
    },
    followUp: async (payload: CapturedPayload) => {
      assertEmbedOnly(payload);
      captured.push(payload);
      return payload;
    },
  };

  return {
    interaction,
    captured,
    getLastEmbedJson() {
      const last = captured[captured.length - 1];
      const emb = last?.embeds?.[0];
      return emb?.toJSON ? emb.toJSON() : (emb as unknown as Record<string, unknown>);
    },
  };
}

test('discord-bot-export contains complete independent deployment package matching discord-bot/index.js', () => {
  const exportDir = path.resolve(process.cwd(), 'discord-bot-export');
  const files = fs.readdirSync(exportDir).sort();
  assert.deepEqual(
    files,
    ['.env', '.env.example', 'README.md', 'index.js', 'package.json'],
    'discord-bot-export must contain the complete self-hosting deployment package'
  );

  const botSrc = fs.readFileSync(path.resolve(process.cwd(), 'discord-bot/index.js'), 'utf8');
  const exportSrc = fs.readFileSync(path.join(exportDir, 'index.js'), 'utf8');
  assert.equal(exportSrc, botSrc, 'discord-bot-export/index.js must match discord-bot/index.js');
  assert.equal(exportSrc.includes('../src'), false, 'Exported bot must not depend on internal project files');
  assert.equal(exportSrc.includes('happy106725@'), false, 'Exported bot must not contain default password');

  const pkg = JSON.parse(fs.readFileSync(path.join(exportDir, 'package.json'), 'utf8'));
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.scripts?.start, 'node index.js');
  assert.ok(pkg.dependencies?.['discord.js'], 'package.json must depend on discord.js');

  const envFile = fs.readFileSync(path.join(exportDir, '.env'), 'utf8');
  assert.ok(envFile.includes('DISCORD_BOT_TOKEN='), '.env must define DISCORD_BOT_TOKEN');
  assert.ok(envFile.includes('BOT_API_SECRET='), '.env must define BOT_API_SECRET');
  assert.ok(envFile.includes('API_BASE_URL='), '.env must define API_BASE_URL');
  assert.ok(envFile.includes('DISCORD_ADMIN_IDS=1390253651574132828'), '.env must populate DISCORD_ADMIN_IDS');

  const envExample = fs.readFileSync(path.join(exportDir, '.env.example'), 'utf8');
  assert.ok(envExample.includes('DISCORD_BOT_TOKEN='), '.env.example must define DISCORD_BOT_TOKEN');
  assert.ok(envExample.includes('DISCORD_ADMIN_IDS=1390253651574132828'), '.env.example must include default admin ID');
  assert.equal(envExample.includes('64191f8148'), false, '.env.example must not leak actual secrets');

  const readme = fs.readFileSync(path.join(exportDir, 'README.md'), 'utf8');
  assert.ok(readme.includes('/test-on') && readme.includes('/test-off'), 'README must document Admin Test Mode');
});

test('Discord Bot commands enforce Embed-Only policy, permission checks, cooldowns, and API communication', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moon-bot-test-'));
  const store = new RegistryStore({ stateFilePath: path.join(dir, 'registry.json') });
  const secret = 'bot-integration-test-secret-0987654321';
  const adminId = '999999999999999999';
  const userA = '111111111111111111';
  const userB = '222222222222222222';
  process.env.DISCORD_ADMIN_IDS = adminId;

  const app = express();
  app.use(express.json());
  app.use(
    '/api/v1',
    createManagementRouter({
      store,
      vmAdapter: createBotTestVmAdapter(),
      getSecret: () => secret,
    })
  );

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const apiBaseUrl = `http://127.0.0.1:${port}`;

  try {
    // Dynamically import the exported standalone index.js to prove it runs cleanly!
    const botMod = await import('../../discord-bot-export/index.js');
    const ctx = botMod.createBotContext({
      apiBaseUrl,
      botSecret: secret,
      adminIds: new Set([adminId]),
    });

    // Verify full command suite is registered (far beyond just /create-vps and /delete)
    const expectedCommands = [
      'help',
      'status',
      'create-vps',
      'delete',
      'list-vps',
      'vps-info',
      'vps-power',
      'register-machine',
      'list-machines',
      'machine-info',
      'update-machine',
      'delete-machine',
      'profile',
      'admin-user',
      'test-on',
      'test-off',
    ];
    for (const cmdName of expectedCommands) {
      assert.ok(ctx.commands.has(cmdName), `Missing slash command /${cmdName}`);
      assert.ok(ctx.commands.get(cmdName).data.toJSON().name === cmdName);
    }

    // 1. /help -> Embed-only
    const helpMock = createMockInteraction({ commandName: 'help', userId: userA });
    await ctx.handleInteraction(helpMock.interaction);
    assert.ok(String(helpMock.getLastEmbedJson().title).includes('Moon Studio'));

    // 2. /status -> Embed-only
    const statusMock = createMockInteraction({ commandName: 'status', userId: userA });
    await ctx.handleInteraction(statusMock.interaction);
    assert.ok(String(statusMock.getLastEmbedJson().title).includes('Operational'));

    // 3. /create-vps by User A -> creates VPS & responds with Embed
    const createMock = createMockInteraction({
      commandName: 'create-vps',
      userId: userA,
      strings: { os: 'debian-12', name: 'Bot-Debian-VPS' },
      integers: { cores: 2, memory_mb: 2048, disk_gb: 40 },
    });
    await ctx.handleInteraction(createMock.interaction);
    const createEmbed = createMock.getLastEmbedJson();
    assert.ok(String(createEmbed.title).includes('Provisioned Successfully'));
    const vpsField = (createEmbed.fields as Array<{ name: string; value: string }>).find((f) => f.name === 'VPS ID');
    assert.ok(vpsField);
    const createdVpsId = vpsField.value.replace(/`/g, '').trim();

    // 4. User A immediately tries /register-machine -> hits 429 Cooldown Embed
    const cooldownMock = createMockInteraction({
      commandName: 'register-machine',
      userId: userA,
      strings: { machine_id: 'node-blocked-01' },
    });
    await ctx.handleInteraction(cooldownMock.interaction);
    assert.ok(String(cooldownMock.getLastEmbedJson().title).includes('Cooldown Active'));

    // 5. User B registers a machine independently -> Embed success
    const regMockB = createMockInteraction({
      commandName: 'register-machine',
      userId: userB,
      strings: { machine_id: 'node-userb-01', name: 'UserB Node', os: 'windows-7' },
    });
    await ctx.handleInteraction(regMockB.interaction);
    assert.ok(String(regMockB.getLastEmbedJson().title).includes('Machine Registered'));

    // 6. User B tries /delete on User A's VPS -> Permission Denied Embed (403)
    const forbidDelMock = createMockInteraction({
      commandName: 'delete',
      userId: userB,
      strings: { vps_id: createdVpsId },
    });
    await ctx.handleInteraction(forbidDelMock.interaction);
    assert.ok(String(forbidDelMock.getLastEmbedJson().title).includes('Permission Denied'));

    // 7. User A runs /list-vps, /vps-info, /vps-power, /profile -> all Embeds
    const listVpsMock = createMockInteraction({ commandName: 'list-vps', userId: userA });
    await ctx.handleInteraction(listVpsMock.interaction);
    assert.ok(String(listVpsMock.getLastEmbedJson().title).includes('Cloud VPS Instances'));

    const infoVpsMock = createMockInteraction({
      commandName: 'vps-info',
      userId: userA,
      strings: { vps_id: createdVpsId },
    });
    await ctx.handleInteraction(infoVpsMock.interaction);
    assert.ok(String(infoVpsMock.getLastEmbedJson().title).includes('VPS Details'));

    const powerMock = createMockInteraction({
      commandName: 'vps-power',
      userId: userA,
      strings: { vps_id: createdVpsId, action: 'restart', name: 'Bot-Renamed' },
    });
    await ctx.handleInteraction(powerMock.interaction);
    assert.ok(String(powerMock.getLastEmbedJson().title).includes('VPS Action Executed'));

    const profileMock = createMockInteraction({ commandName: 'profile', userId: userA });
    await ctx.handleInteraction(profileMock.interaction);
    assert.ok(String(profileMock.getLastEmbedJson().title).includes('Discord User Profile'));

    // 8. Non-admin User A tries /admin-user -> Permission Denied Embed
    const nonAdminMock = createMockInteraction({
      commandName: 'admin-user',
      userId: userA,
      subcommand: 'list',
    });
    await ctx.handleInteraction(nonAdminMock.interaction);
    assert.ok(String(nonAdminMock.getLastEmbedJson().title).includes('Administrator Permission Required'));

    // 9. Admin runs /admin-user list -> Success Embed
    const adminMock = createMockInteraction({
      commandName: 'admin-user',
      userId: adminId,
      subcommand: 'list',
    });
    await ctx.handleInteraction(adminMock.interaction);
    assert.ok(String(adminMock.getLastEmbedJson().title).includes('Registered Discord Users'));

    // 10. User A runs /delete on own VPS -> Success Embed
    const delMockA = createMockInteraction({
      commandName: 'delete',
      userId: userA,
      strings: { vps_id: createdVpsId },
    });
    await ctx.handleInteraction(delMockA.interaction);
    assert.ok(String(delMockA.getLastEmbedJson().title).includes('Cloud VPS Deleted'));

    // 11. Unknown command & unreachable API both respond safely with Embeds (never crash!)
    const unknownMock = createMockInteraction({ commandName: 'nonexistent-cmd', userId: userA });
    await ctx.handleInteraction(unknownMock.interaction);
    assert.ok(String(unknownMock.getLastEmbedJson().title).includes('Unknown Command'));

    const offlineCtx = botMod.createBotContext({
      apiBaseUrl: 'http://127.0.0.1:59999',
      botSecret: secret,
    });
    const offlineStatusMock = createMockInteraction({ commandName: 'status', userId: userA });
    await offlineCtx.handleInteraction(offlineStatusMock.interaction);
    assert.ok(String(offlineStatusMock.getLastEmbedJson().title).includes('Failed'));

    // 12. Admin Test Mode (/test-on and /test-off) strictly checks exact ID 1390253651574132828
    const fakeServerAdminOn = createMockInteraction({
      commandName: 'test-on',
      userId: adminId,
      isDiscordAdmin: true,
    });
    await ctx.handleInteraction(fakeServerAdminOn.interaction);
    assert.equal(fakeServerAdminOn.getLastEmbedJson().title, 'Unauthorized Access');

    const fakeServerAdminOff = createMockInteraction({
      commandName: 'test-off',
      userId: userA,
      isDiscordAdmin: true,
    });
    await ctx.handleInteraction(fakeServerAdminOff.interaction);
    assert.equal(fakeServerAdminOff.getLastEmbedJson().title, 'Unauthorized Access');

    // Authorized Admin turns Test Mode ON -> Blue Embed
    const authTestOn = createMockInteraction({
      commandName: 'test-on',
      userId: AUTHORIZED_ADMIN_ID,
      username: 'AuthorizedAdmin',
    });
    await ctx.handleInteraction(authTestOn.interaction);
    const onEmbed = authTestOn.getLastEmbedJson();
    assert.equal(onEmbed.title, 'Admin Test Mode');
    assert.equal(onEmbed.color, botMod.COLORS.TEST_MODE_ON);
    assert.ok(String(onEmbed.description).includes('enabled successfully'));

    // Authorized Admin executes consecutive creation commands without cooldown
    const adminVps = createMockInteraction({
      commandName: 'create-vps',
      userId: AUTHORIZED_ADMIN_ID,
      strings: { os: 'debian-12', name: 'Admin-Rapid-1' },
    });
    await ctx.handleInteraction(adminVps.interaction);
    assert.ok(String(adminVps.getLastEmbedJson().title).includes('Provisioned Successfully'));

    const adminMachine = createMockInteraction({
      commandName: 'register-machine',
      userId: AUTHORIZED_ADMIN_ID,
      strings: { machine_id: 'admin-rapid-node-1' },
    });
    await ctx.handleInteraction(adminMachine.interaction);
    assert.ok(String(adminMachine.getLastEmbedJson().title).includes('Machine Registered'));

    const adminProfile = createMockInteraction({
      commandName: 'profile',
      userId: AUTHORIZED_ADMIN_ID,
    });
    await ctx.handleInteraction(adminProfile.interaction);
    const cooldownField = (adminProfile.getLastEmbedJson().fields as Array<{ name: string; value: string }>).find(
      (f) => f.name.includes('POST Cooldown')
    );
    assert.ok(cooldownField?.value.includes('Bypassed'));

    // Ordinary user still receives cooldown Embed while Test Mode is ON
    const userBBlocked = createMockInteraction({
      commandName: 'register-machine',
      userId: userB,
      strings: { machine_id: 'node-userb-blocked' },
    });
    await ctx.handleInteraction(userBBlocked.interaction);
    assert.ok(String(userBBlocked.getLastEmbedJson().title).includes('Cooldown Active'));

    // Authorized Admin turns Test Mode OFF -> Green Embed & immediate 600s cooldown restored
    const authTestOff = createMockInteraction({
      commandName: 'test-off',
      userId: AUTHORIZED_ADMIN_ID,
    });
    await ctx.handleInteraction(authTestOff.interaction);
    const offEmbed = authTestOff.getLastEmbedJson();
    assert.equal(offEmbed.title, 'Admin Test Mode');
    assert.equal(offEmbed.color, botMod.COLORS.TEST_MODE_OFF);
    assert.ok(String(offEmbed.description).includes('disabled'));

    const adminBlockedAfterOff = createMockInteraction({
      commandName: 'register-machine',
      userId: AUTHORIZED_ADMIN_ID,
      strings: { machine_id: 'admin-blocked-after-off' },
    });
    await ctx.handleInteraction(adminBlockedAfterOff.interaction);
    assert.ok(String(adminBlockedAfterOff.getLastEmbedJson().title).includes('Cooldown Active'));
  } finally {
    delete process.env.DISCORD_ADMIN_IDS;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
