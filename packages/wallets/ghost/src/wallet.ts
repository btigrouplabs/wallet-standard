import {
    BBAChainSignAndSendTransaction,
    type BBAChainSignAndSendTransactionFeature,
    type BBAChainSignAndSendTransactionMethod,
    type BBAChainSignAndSendTransactionOutput,
    BBAChainSignIn,
    type BBAChainSignInFeature,
    type BBAChainSignInMethod,
    type BBAChainSignInOutput,
    BBAChainSignMessage,
    type BBAChainSignMessageFeature,
    type BBAChainSignMessageMethod,
    type BBAChainSignMessageOutput,
    BBAChainSignTransaction,
    type BBAChainSignTransactionFeature,
    type BBAChainSignTransactionMethod,
    type BBAChainSignTransactionOutput,
} from '@bbachain/wallet-standard-features';
import type { Transaction } from '@bbachain/web3.js';
import { VersionedTransaction } from '@bbachain/web3.js';
import type { Wallet } from '@wallet-standard/base';
import {
    StandardConnect,
    type StandardConnectFeature,
    type StandardConnectMethod,
    StandardDisconnect,
    type StandardDisconnectFeature,
    type StandardDisconnectMethod,
    StandardEvents,
    type StandardEventsFeature,
    type StandardEventsListeners,
    type StandardEventsNames,
    type StandardEventsOnMethod,
} from '@wallet-standard/features';
import bs58 from 'bs58';
import { GhostWalletAccount } from './account.js';
import { icon } from './icon.js';
import type { BBAChain } from './bbachain.js';
import { isBBAChain, isVersionedTransaction, BBACHAIN_CHAINS } from './bbachain.js';
import { bytesEqual } from './util.js';
import type { Ghost } from './window.js';

export const GhostNamespace = 'ghost:';

export type GhostFeature = {
    [GhostNamespace]: {
        ghost: Ghost;
    };
};

export class GhostWallet implements Wallet {
    readonly #listeners: { [E in StandardEventsNames]?: StandardEventsListeners[E][] } = {};
    readonly #version = '1.0.0' as const;
    readonly #name = 'Ghost' as const;
    readonly #icon = icon;
    #account: GhostWalletAccount | null = null;
    readonly #ghost: Ghost;

    get version() {
        return this.#version;
    }

    get name() {
        return this.#name;
    }

    get icon() {
        return this.#icon;
    }

    get chains() {
        return BBACHAIN_CHAINS.slice();
    }

    get features(): StandardConnectFeature &
        StandardDisconnectFeature &
        StandardEventsFeature &
        BBAChainSignAndSendTransactionFeature &
        BBAChainSignTransactionFeature &
        BBAChainSignMessageFeature &
        BBAChainSignInFeature &
        GhostFeature {
        return {
            [StandardConnect]: {
                version: '1.0.0',
                connect: this.#connect,
            },
            [StandardDisconnect]: {
                version: '1.0.0',
                disconnect: this.#disconnect,
            },
            [StandardEvents]: {
                version: '1.0.0',
                on: this.#on,
            },
            [BBAChainSignAndSendTransaction]: {
                version: '1.0.0',
                supportedTransactionVersions: ['legacy', 0],
                signAndSendTransaction: this.#signAndSendTransaction,
            },
            [BBAChainSignTransaction]: {
                version: '1.0.0',
                supportedTransactionVersions: ['legacy', 0],
                signTransaction: this.#signTransaction,
            },
            [BBAChainSignMessage]: {
                version: '1.0.0',
                signMessage: this.#signMessage,
            },
            [BBAChainSignIn]: {
                version: '1.0.0',
                signIn: this.#signIn,
            },
            [GhostNamespace]: {
                ghost: this.#ghost,
            },
        };
    }

    get accounts() {
        return this.#account ? [this.#account] : [];
    }

    constructor(ghost: Ghost) {
        if (new.target === GhostWallet) {
            Object.freeze(this);
        }

        this.#ghost = ghost;

        ghost.on('connect', this.#connected, this);
        ghost.on('disconnect', this.#disconnected, this);
        ghost.on('accountChanged', this.#reconnected, this);

        this.#connected();
    }

    #on: StandardEventsOnMethod = (event, listener) => {
        this.#listeners[event]?.push(listener) || (this.#listeners[event] = [listener]);
        return (): void => this.#off(event, listener);
    };

    #emit<E extends StandardEventsNames>(event: E, ...args: Parameters<StandardEventsListeners[E]>): void {
        // eslint-disable-next-line prefer-spread
        this.#listeners[event]?.forEach((listener) => listener.apply(null, args));
    }

    #off<E extends StandardEventsNames>(event: E, listener: StandardEventsListeners[E]): void {
        this.#listeners[event] = this.#listeners[event]?.filter((existingListener) => listener !== existingListener);
    }

    #connected = () => {
        const address = this.#ghost.publicKey?.toBase58();
        if (address) {
            const publicKey = this.#ghost.publicKey!.toBytes();

            const account = this.#account;
            if (!account || account.address !== address || !bytesEqual(account.publicKey, publicKey)) {
                this.#account = new GhostWalletAccount({ address, publicKey });
                this.#emit('change', { accounts: this.accounts });
            }
        }
    };

    #disconnected = () => {
        if (this.#account) {
            this.#account = null;
            this.#emit('change', { accounts: this.accounts });
        }
    };

    #reconnected = () => {
        if (this.#ghost.publicKey) {
            this.#connected();
        } else {
            this.#disconnected();
        }
    };

    #connect: StandardConnectMethod = async ({ silent } = {}) => {
        if (!this.#account) {
            await this.#ghost.connect(silent ? { onlyIfTrusted: true } : undefined);
        }

        this.#connected();

        return { accounts: this.accounts };
    };

    #disconnect: StandardDisconnectMethod = async () => {
        await this.#ghost.disconnect();
    };

    #signAndSendTransaction: BBAChainSignAndSendTransactionMethod = async (...inputs) => {
        if (!this.#account) throw new Error('not connected');

        const outputs: BBAChainSignAndSendTransactionOutput[] = [];

        if (inputs.length === 1) {
            const { transaction, account, chain, options } = inputs[0]!;
            const { minContextSlot, preflightCommitment, skipPreflight, maxRetries } = options || {};
            if (account !== this.#account) throw new Error('invalid account');
            if (!isBBAChain(chain)) throw new Error('invalid chain');

            const { signature } = await this.#ghost.signAndSendTransaction(
                VersionedTransaction.deserialize(transaction),
                {
                    preflightCommitment,
                    minContextSlot,
                    maxRetries,
                    skipPreflight,
                }
            );

            outputs.push({ signature: bs58.decode(signature) });
        } else if (inputs.length > 1) {
            for (const input of inputs) {
                outputs.push(...(await this.#signAndSendTransaction(input)));
            }
        }

        return outputs;
    };

    #signTransaction: BBAChainSignTransactionMethod = async (...inputs) => {
        if (!this.#account) throw new Error('not connected');

        const outputs: BBAChainSignTransactionOutput[] = [];

        if (inputs.length === 1) {
            const { transaction, account, chain } = inputs[0]!;
            if (account !== this.#account) throw new Error('invalid account');
            if (chain && !isBBAChain(chain)) throw new Error('invalid chain');

            const signedTransaction = await this.#ghost.signTransaction(VersionedTransaction.deserialize(transaction));

            const serializedTransaction = isVersionedTransaction(signedTransaction)
                ? signedTransaction.serialize()
                : new Uint8Array(
                      (signedTransaction as Transaction).serialize({
                          requireAllSignatures: false,
                          verifySignatures: false,
                      })
                  );

            outputs.push({ signedTransaction: serializedTransaction });
        } else if (inputs.length > 1) {
            let chain: BBAChain | undefined = undefined;
            for (const input of inputs) {
                if (input.account !== this.#account) throw new Error('invalid account');
                if (input.chain) {
                    if (!isBBAChain(input.chain)) throw new Error('invalid chain');
                    if (chain) {
                        if (input.chain !== chain) throw new Error('conflicting chain');
                    } else {
                        chain = input.chain;
                    }
                }
            }

            const transactions = inputs.map(({ transaction }) => VersionedTransaction.deserialize(transaction));

            const signedTransactions = await this.#ghost.signAllTransactions(transactions);

            outputs.push(
                ...signedTransactions.map((signedTransaction) => {
                    const serializedTransaction = isVersionedTransaction(signedTransaction)
                        ? signedTransaction.serialize()
                        : new Uint8Array(
                              (signedTransaction as Transaction).serialize({
                                  requireAllSignatures: false,
                                  verifySignatures: false,
                              })
                          );

                    return { signedTransaction: serializedTransaction };
                })
            );
        }

        return outputs;
    };

    #signMessage: BBAChainSignMessageMethod = async (...inputs) => {
        if (!this.#account) throw new Error('not connected');

        const outputs: BBAChainSignMessageOutput[] = [];

        if (inputs.length === 1) {
            const { message, account } = inputs[0]!;
            if (account !== this.#account) throw new Error('invalid account');

            const { signature } = await this.#ghost.signMessage(message);

            outputs.push({ signedMessage: message, signature });
        } else if (inputs.length > 1) {
            for (const input of inputs) {
                outputs.push(...(await this.#signMessage(input)));
            }
        }

        return outputs;
    };

    #signIn: BBAChainSignInMethod = async (...inputs) => {
        const outputs: BBAChainSignInOutput[] = [];

        if (inputs.length > 1) {
            for (const input of inputs) {
                outputs.push(await this.#ghost.signIn(input));
            }
        } else {
            return [await this.#ghost.signIn(inputs[0])];
        }

        return outputs;
    };
}
