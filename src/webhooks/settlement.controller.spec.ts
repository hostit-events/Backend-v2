import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PaymentProvider, TransactionStatus } from '@prisma/client';
import { SettlementController } from './settlement.controller';

function txn(overrides: Record<string, unknown> = {}) {
  return {
    id: 't-1',
    reference: 'HOSTIT_TXN_ABC123',
    provider: PaymentProvider.PAYSTACK,
    status: TransactionStatus.PENDING,
    amount: 5000,
    currency: 'NGN',
    ...overrides,
  };
}

/** Minimal express Response stand-in that captures what was sent. */
function fakeRes() {
  const sent = {
    status: 0,
    type: '',
    body: '',
    headers: {} as Record<string, string>,
  };
  const res = {
    status(code: number) {
      sent.status = code;
      return this;
    },
    type(t: string) {
      sent.type = t;
      return this;
    },
    header(k: string, v: string) {
      sent.headers[k] = v;
      return this;
    },
    send(body: string) {
      sent.body = body;
      return this;
    },
  };
  return { res, sent };
}

function setup(opts: { transaction?: unknown; verify?: unknown } = {}) {
  const findUnique = jest
    .fn()
    .mockResolvedValue(
      opts.transaction === undefined ? txn() : opts.transaction,
    );
  const verifyPayment = jest.fn().mockResolvedValue(
    opts.verify ?? {
      status: 'success',
      amount: 5000,
      reference: 'HOSTIT_TXN_ABC123',
      providerReference: '123456',
      channel: 'card',
      paidAt: new Date('2026-08-01T10:00:00Z'),
    },
  );
  const handleSuccess = jest.fn().mockResolvedValue(undefined);
  const handleFailure = jest.fn().mockResolvedValue(undefined);

  const controller = new SettlementController(
    { verifyPayment } as never,
    { handleSuccess, handleFailure } as never,
    { transaction: { findUnique } } as never,
  );

  return {
    controller,
    findUnique,
    verifyPayment,
    handleSuccess,
    handleFailure,
  };
}

describe('SettlementController.verify', () => {
  it('settles a PENDING transaction the gateway reports as paid', async () => {
    const { controller, handleSuccess } = setup();

    const res = await controller.verify('HOSTIT_TXN_ABC123');

    expect(handleSuccess).toHaveBeenCalledTimes(1);
    expect(handleSuccess).toHaveBeenCalledWith({
      reference: 'HOSTIT_TXN_ABC123',
      provider: PaymentProvider.PAYSTACK,
      providerReference: '123456',
      amount: 5000,
      channel: 'card',
      paidAt: new Date('2026-08-01T10:00:00Z'),
    });
    expect(res).toEqual({
      reference: 'HOSTIT_TXN_ABC123',
      status: TransactionStatus.SUCCESS,
      settled: true,
    });
  });

  it('does not re-verify an already-settled transaction', async () => {
    const { controller, verifyPayment, handleSuccess } = setup({
      transaction: txn({ status: TransactionStatus.SUCCESS }),
    });

    const res = await controller.verify('HOSTIT_TXN_ABC123');

    expect(verifyPayment).not.toHaveBeenCalled();
    expect(handleSuccess).not.toHaveBeenCalled();
    expect(res.settled).toBe(true);
  });

  it('releases inventory when the gateway reports failure', async () => {
    const { controller, handleFailure, handleSuccess } = setup({
      verify: {
        status: 'failed',
        amount: 0,
        reference: 'x',
        providerReference: 'y',
      },
    });

    const res = await controller.verify('HOSTIT_TXN_ABC123');

    expect(handleFailure).toHaveBeenCalledTimes(1);
    expect(handleSuccess).not.toHaveBeenCalled();
    expect(res.status).toBe(TransactionStatus.FAILED);
  });

  it('stays PENDING while the gateway is still processing', async () => {
    const { controller, handleSuccess, handleFailure } = setup({
      verify: {
        status: 'pending',
        amount: 0,
        reference: 'x',
        providerReference: 'y',
      },
    });

    const res = await controller.verify('HOSTIT_TXN_ABC123');

    expect(handleSuccess).not.toHaveBeenCalled();
    expect(handleFailure).not.toHaveBeenCalled();
    expect(res).toEqual({
      reference: 'HOSTIT_TXN_ABC123',
      status: TransactionStatus.PENDING,
      settled: false,
    });
  });

  it('refuses to mint on an underpayment', async () => {
    const { controller, handleSuccess } = setup({
      verify: {
        status: 'success',
        amount: 100, // gateway says NGN 100, order was NGN 5000
        reference: 'HOSTIT_TXN_ABC123',
        providerReference: '123456',
      },
    });

    const res = await controller.verify('HOSTIT_TXN_ABC123');

    expect(handleSuccess).not.toHaveBeenCalled();
    expect(res.settled).toBe(false);
    expect(res.error).toMatch(/does not match/i);
  });

  it('leaves crypto transactions to the Circle webhook', async () => {
    const { controller, verifyPayment } = setup({
      transaction: txn({ provider: PaymentProvider.CRYPTO }),
    });

    const res = await controller.verify('HOSTIT_TXN_ABC123');

    expect(verifyPayment).not.toHaveBeenCalled();
    expect(res.status).toBe(TransactionStatus.PENDING);
  });

  it('404s on an unknown reference', async () => {
    const { controller } = setup({ transaction: null });

    await expect(controller.verify('nope')).rejects.toThrow(NotFoundException);
  });

  it('rejects a blank reference before touching the database', async () => {
    const { controller, findUnique } = setup();

    await expect(controller.verify('   ')).rejects.toThrow(BadRequestException);
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe('SettlementController.callback', () => {
  it('settles and reports success in a machine-readable form', async () => {
    const { controller, handleSuccess } = setup();
    const { res, sent } = fakeRes();

    await controller.callback(res as never, 'HOSTIT_TXN_ABC123');

    expect(handleSuccess).toHaveBeenCalledTimes(1);
    expect(sent.status).toBe(200);
    expect(sent.type).toBe('text/html');
    expect(sent.body).toContain('<meta name="cp-status" content="SUCCESS">');
    expect(sent.body).toContain('<meta name="cp-settled" content="true">');
    expect(sent.body).toContain('data-reference="HOSTIT_TXN_ABC123"');
  });

  it("accepts Paystack's trxref and Monnify's paymentReference", async () => {
    const viaTrxref = setup();
    await viaTrxref.controller.callback(
      fakeRes().res as never,
      undefined,
      'HOSTIT_TXN_ABC123',
    );
    expect(viaTrxref.handleSuccess).toHaveBeenCalledTimes(1);

    const viaMonnify = setup();
    await viaMonnify.controller.callback(
      fakeRes().res as never,
      undefined,
      undefined,
      'HOSTIT_TXN_ABC123',
    );
    expect(viaMonnify.handleSuccess).toHaveBeenCalledTimes(1);
  });

  it('renders a page instead of throwing when the reference is unknown', async () => {
    const { controller } = setup({ transaction: null });
    const { res, sent } = fakeRes();

    await controller.callback(res as never, 'nope');

    // The buyer may already have been charged — a 500 here would be the
    // worst possible outcome.
    expect(sent.status).toBe(200);
    expect(sent.body).toContain('<meta name="cp-settled" content="false">');
    expect(sent.body).toContain('could not confirm');
  });

  it('renders a page when no reference is supplied at all', async () => {
    const { controller, findUnique } = setup();
    const { res, sent } = fakeRes();

    await controller.callback(res as never);

    expect(findUnique).not.toHaveBeenCalled();
    expect(sent.body).toContain('No payment reference');
  });

  it('escapes the reference so it cannot inject markup', async () => {
    const { controller } = setup({ transaction: null });
    const { res, sent } = fakeRes();

    await controller.callback(res as never, '"><script>alert(1)</script>');

    expect(sent.body).not.toContain('<script>alert(1)</script>');
    expect(sent.body).toContain('&lt;script&gt;');
  });

  it('never caches the result page', async () => {
    const { controller } = setup();
    const { res, sent } = fakeRes();

    await controller.callback(res as never, 'HOSTIT_TXN_ABC123');

    expect(sent.headers['Cache-Control']).toBe('no-store');
  });
});
