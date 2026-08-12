import {NativeModules} from 'react-native';
import RNPrint from 'react-native-print';

const printerMock = {
  setAlignment: jest.fn(),
  setTextBold: jest.fn(),
  printText: jest.fn(),
  printQRCode: jest.fn(),
  nextLine: jest.fn(),
};
NativeModules.PrinterModule = printerMock;

jest.mock('react-native-print', () => ({
  __esModule: true,
  default: {print: jest.fn()},
}));

const mockState = {
  user: {username: 'merchant'},
  amount: {
    satAmount: 800,
    displayAmount: '8.00',
    currency: {
      id: 'USD',
      symbol: '$',
      name: 'US Dollar',
      flag: '🇺🇸',
      fractionDigits: 2,
    },
    memo: '',
  },
};

jest.mock('../../src/store/hooks', () => ({
  useAppSelector: (selector: (state: unknown) => unknown) =>
    selector(mockState),
}));

// PrinterModule is destructured at module load — require after the mock is set
const usePrint = require('../../src/hooks/usePrint').default;

const baseReceipt: ReceiptData = {
  id: 'tx_1',
  timestamp: '2026-08-11T12:00:00.000Z',
  satAmount: 800,
  displayAmount: '8.00',
  currency: {
    id: 'USD',
    symbol: '$',
    name: 'US Dollar',
    flag: '🇺🇸',
    fractionDigits: 2,
  },
  isPrimaryAmountSats: false,
  username: 'merchant',
  memo: 'coffee',
  paymentHash: 'hash',
  status: 'Paid',
  transactionType: 'lightning',
};

describe('usePrint receipt headlines', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('printReceipt prints "Sale completed" for a sale', () => {
    const {printReceipt} = usePrint();
    printReceipt(baseReceipt);
    expect(printerMock.printText).toHaveBeenNthCalledWith(
      1,
      'Sale completed\n',
    );
  });

  it('printReceipt prints "Refund completed" for a refund', () => {
    const {printReceipt} = usePrint();
    printReceipt({
      ...baseReceipt,
      transactionType: 'refund',
      satAmount: -800,
      displayAmount: '-8.00',
    });
    expect(printerMock.printText).toHaveBeenNthCalledWith(
      1,
      'Refund completed\n',
    );
    expect(printerMock.printText).not.toHaveBeenCalledWith('Sale completed\n');
  });

  it('printReceipt defaults to "Sale completed" when transactionType is absent', () => {
    const {printReceipt} = usePrint();
    printReceipt({...baseReceipt, transactionType: undefined});
    expect(printerMock.printText).toHaveBeenNthCalledWith(
      1,
      'Sale completed\n',
    );
  });

  it('printReceiptHTML renders "Refund completed" for a refund', async () => {
    const {printReceiptHTML} = usePrint();
    await printReceiptHTML({
      ...baseReceipt,
      transactionType: 'refund',
      satAmount: -800,
      displayAmount: '-8.00',
    });
    const html = (RNPrint.print as jest.Mock).mock.calls[0][0].html;
    expect(html).toContain('Refund completed');
    expect(html).not.toContain('Sale completed');
  });

  it('printReceiptHTML renders "Sale completed" for a sale', async () => {
    const {printReceiptHTML} = usePrint();
    await printReceiptHTML(baseReceipt);
    const html = (RNPrint.print as jest.Mock).mock.calls[0][0].html;
    expect(html).toContain('Sale completed');
    expect(html).not.toContain('Refund completed');
  });
});
