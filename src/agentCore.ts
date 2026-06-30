import 'dotenv/config';
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders, FileStorageProvider } from '@unicitylabs/sphere-sdk/impl/nodejs';
import { ActivityLog } from './approvalQueue.js';

const NETWORK = (process.env.SPHERE_NETWORK ?? 'testnet') as 'testnet' | 'mainnet' | 'dev';

export async function initAgent(log: ActivityLog) {
  const providers = createNodeProviders({
    network: NETWORK,
    dataDir: './wallet-data',
    tokensDir: './tokens',
    oracle: {
      apiKey: process.env.SPHERE_ORACLE_API_KEY,
    },
    price: { platform: 'coingecko' },
  } as any);

  const mnemonic = process.env.WALLET_MNEMONIC || undefined;

  const { sphere, created, generatedMnemonic } = await Sphere.init({
    ...providers,
    autoGenerate: true,
    mnemonic,
    nametag: process.env.AGENT_NAMETAG || undefined,
    groupChat: false,
  });

  if (created && generatedMnemonic) {
    log.log(
      'warn',
      `New wallet created. SAVE THIS MNEMONIC (it will not be shown again): ${generatedMnemonic}`,
    );
    log.log(
      'warn',
      'Set WALLET_MNEMONIC in your .env to this value so the agent keeps the same identity on restart.',
    );
  }

  log.log('info', `Agent identity: ${sphere.identity?.directAddress} (network: ${NETWORK})`);
  if (sphere.identity?.nametag) {
    log.log('info', `Registered nametag: @${sphere.identity.nametag}`);
  }

  // Surface incoming DMs (counterparties negotiating with this agent) into
  // the activity log so the operator can see what's happening even before
  // a deal is proposed.
  sphere.communications.onDirectMessage((msg: any) => {
    log.log('info', `DM from ${msg.senderNametag ?? msg.senderPubkey}: ${msg.content}`);
  });

  return sphere;
}

export type SphereInstance = Awaited<ReturnType<typeof initAgent>>;
