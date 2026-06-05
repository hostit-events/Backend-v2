/**
 * Multi-chain registry. Each event/ticket lives on exactly one chain
 * (organizer picks at creation), and HostIT supports multiple chains
 * concurrently. New chains are added by editing CHAIN_DEFINITIONS plus
 * shipping per-chain RPC and Diamond env vars; activation is driven by
 * the ACTIVE_CHAINS env list.
 *
 * EVM-only at MVP. The Circle "blockchain" identifier is stored
 * separately because non-EVM chains (Solana, Tron) use different
 * naming when we eventually add them.
 */

export type ChainId = 'BASE-SEPOLIA' | 'BASE' | 'ARC-TESTNET';

export interface ChainConfig {
  id: ChainId;
  displayName: string;
  evmChainId: number;
  rpcUrl: string;
  diamondAddress: string;
  /** Canonical USDC contract on this chain (Circle-issued). */
  usdcAddress: string;
  blockExplorer: string;
  isTestnet: boolean;
  /** Chain identifier used by Circle's API (often the same as our id). */
  circleBlockchain: string;
}

/**
 * Static metadata per chain. RPC URL and Diamond address come from env
 * (deploy-time config) so they're not in this map.
 */
type StaticChainConfig = Omit<ChainConfig, 'rpcUrl' | 'diamondAddress'>;

const CHAIN_DEFINITIONS: Record<ChainId, StaticChainConfig> = {
  'BASE-SEPOLIA': {
    id: 'BASE-SEPOLIA',
    displayName: 'Base Sepolia',
    evmChainId: 84532,
    usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    blockExplorer: 'https://sepolia.basescan.org',
    isTestnet: true,
    circleBlockchain: 'BASE-SEPOLIA',
  },
  BASE: {
    id: 'BASE',
    displayName: 'Base',
    evmChainId: 8453,
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    blockExplorer: 'https://basescan.org',
    isTestnet: false,
    circleBlockchain: 'BASE',
  },
  // Arc Testnet — Circle's EVM L1 where USDC is the native gas token.
  // Treasury wallet must be funded with USDC (not ETH) for gas on this
  // chain; faucet: https://faucet.circle.com. `circleBlockchain` follows
  // the same kebab convention as Circle's other testnets; verify against
  // Circle docs if createWallets/contract-exec calls reject the value.
  'ARC-TESTNET': {
    id: 'ARC-TESTNET',
    displayName: 'Arc Testnet',
    evmChainId: 5042002,
    usdcAddress: '0x3600000000000000000000000000000000000000',
    blockExplorer: 'https://testnet.arcscan.app',
    isTestnet: true,
    circleBlockchain: 'ARC-TESTNET',
  },
};

/** Convert chain id like "BASE-SEPOLIA" to env-var prefix "BASE_SEPOLIA". */
function envPrefix(chain: ChainId): string {
  return chain.replace(/-/g, '_');
}

function loadActiveChains(): Record<string, ChainConfig> {
  const raw = process.env.ACTIVE_CHAINS || 'BASE-SEPOLIA';
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const result: Record<string, ChainConfig> = {};
  for (const id of ids) {
    const def = CHAIN_DEFINITIONS[id as ChainId];
    if (!def) {
      throw new Error(
        `Unknown chain in ACTIVE_CHAINS: ${id}. Add it to CHAIN_DEFINITIONS in chains.config.ts.`,
      );
    }
    const prefix = envPrefix(id as ChainId);
    const rpcUrl = process.env[`${prefix}_RPC_URL`];
    const diamondAddress = process.env[`${prefix}_DIAMOND_ADDRESS`];
    if (!rpcUrl) {
      throw new Error(
        `Missing env var ${prefix}_RPC_URL for active chain ${id}`,
      );
    }
    if (!diamondAddress) {
      throw new Error(
        `Missing env var ${prefix}_DIAMOND_ADDRESS for active chain ${id}`,
      );
    }
    result[id] = { ...def, rpcUrl, diamondAddress };
  }

  if (Object.keys(result).length === 0) {
    throw new Error('ACTIVE_CHAINS resolved to an empty list');
  }

  return result;
}

let cache: Record<string, ChainConfig> | null = null;

/** Active chains keyed by id. Lazy-loaded on first access. */
function activeChains(): Record<string, ChainConfig> {
  if (!cache) cache = loadActiveChains();
  return cache;
}

/** Reset the cache. Useful in tests that mutate process.env. */
export function _resetChainsCacheForTests(): void {
  cache = null;
}

/** Look up a chain config; throws if the chain isn't in ACTIVE_CHAINS. */
export function getChain(id: string): ChainConfig {
  const chains = activeChains();
  const cfg = chains[id];
  if (!cfg) {
    throw new Error(
      `Chain "${id}" is not active. Active chains: ${Object.keys(chains).join(', ')}`,
    );
  }
  return cfg;
}

export function listActiveChains(opts?: {
  testnetOnly?: boolean;
}): ChainConfig[] {
  const all = Object.values(activeChains());
  if (opts?.testnetOnly) return all.filter((c) => c.isTestnet);
  return all;
}

/**
 * First chain in ACTIVE_CHAINS. Smoke scripts and dev fallbacks use
 * this when the caller hasn't picked a chain explicitly.
 */
export function getDefaultChain(): ChainConfig {
  const chains = listActiveChains();
  return chains[0];
}
