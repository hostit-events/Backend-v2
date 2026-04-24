export const USER_WALLET_QUEUE = 'user-wallet-create';
export const USER_WALLET_JOB = 'create';

export interface UserWalletJobData {
  walletId: string;
  idempotencyKey: string;
}
