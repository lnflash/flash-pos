import moment from 'moment';
import RNPrint from 'react-native-print';
import {NativeModules} from 'react-native';

// hooks
import {useAppSelector} from '../store/hooks';

// env
import {FLASH_LN_ADDRESS} from '@env';

const {PrinterModule} = NativeModules;

const usePrint = () => {
  const {username} = useAppSelector(state => state.user);
  const {satAmount, displayAmount, currency, memo} = useAppSelector(
    state => state.amount,
  );

  const printSilently = () => {
    PrinterModule.setAlignment(1);
    PrinterModule.setTextBold(true);
    PrinterModule.printText(`Sale completed\n`);
    PrinterModule.printText(`${currency.symbol} ${displayAmount}\n`);
    PrinterModule.printText(`≈ ${satAmount} sats\n`);
    PrinterModule.setTextBold(false);
    PrinterModule.printText(`========================\n`);
    PrinterModule.printText(`Paid to:   ${username}\n`);
    PrinterModule.printText(`Date:   ${moment().format('L')}\n`);
    PrinterModule.printText(`Time:   ${moment().format('LTS')}\n`);
    PrinterModule.printText(`Status:   Paid\n`);
    PrinterModule.printText(`Description:   ${memo || 'none'}\n`);
    PrinterModule.printText('========================\n');

    // Print QR code (e.g., payment ID or order number)
    PrinterModule.setAlignment(1);
    PrinterModule.printText(`Download the Flash APP: \n`);
    PrinterModule.printQRCode('https://getflash.io/app', 6, 1);
    PrinterModule.nextLine(4);
  };

  const print = async () => {
    await RNPrint.print({
      html: `
          <div style="display: flex;flex-direction: column;">
            <div style="display: flex;flex-direction: column;align-items: center;">
              <p style="padding: 0; margin: 0; margin-bottom: 10px; font-size: 13; font-weight: 600">Sale completed</p>
              <p style="padding: 0; margin: 0; font-size: 10">${
                currency.symbol
              } ${displayAmount}</p>
              <p style="padding: 0; margin: 0; margin-bottom: 10px; font-size: 10">≈ ${satAmount} sats</p>
            </div>
            <div>
              <div style="display: flex;justify-content: space-between; margin-bottom: 5px">
                <p style="padding: 0; margin: 0; font-size: 10">Paid to: </p>
                <p style="padding: 0; margin: 0; font-size: 10">${username}</p>
              </div>
              <div style="display: flex; justify-content: space-between; padding: 0; margin: 0; margin-bottom: 5px">
                <p style="padding: 0; margin: 0; font-size: 10">Date: </p>
                <p style="padding: 0; margin: 0; font-size: 10">${moment().format(
                  'L',
                )}</p>
              </div>
              <div style="display: flex; justify-content: space-between; padding: 0; margin: 0; margin-bottom: 5px">
                <p style="padding: 0; margin: 0; font-size: 10">Time: </p>
                <p style="padding: 0; margin: 0; font-size: 10">${moment().format(
                  'LTS',
                )}</p>
              </div>
              <div style="display: flex;justify-content: space-between; margin-bottom: 5px">
                <p style="padding: 0; margin: 0; font-size: 10">Status: </p>
                <p style="padding: 0; margin: 0; font-size: 10">Paid</p>
              </div>
              <div style="display: flex;justify-content: space-between; margin-bottom: 20px">
                <p style="padding: 0; margin: 0; font-size: 10">Description: </p>
                <p style="padding: 0; margin: 0; font-size: 10">${
                  memo || 'none'
                }</p>
              </div>
            </div>
            <div style="padding-bottom: 40px; display: flex; flex-direction: column; align-items: center;">
             <p style="padding: 0; margin: 0; margin-bottom: 5px; font-size: 10; font-weight: 600">Download the Flash APP: </p>
             <img src="https://media-hosting.imagekit.io//ddd57a9aba244f9f/Flash_App_Download_Link_QR-code.JPG?Expires=1833265096&Key-Pair-Id=K2ZIVPTIP2VGHC&Signature=2IK4KMXsYzqBiBdXiUUWaMp~UVx0ycnC7Q9a7RzIukQBKBG4o0Z3ZhSwKCU33XDgO8juUFsDosCeYLIu8Xi38mkHYTHSafQuBTczHUaTmuQHwor0pUdM-DVuioaaLSAqVB8iRhCMMLR5pRwFagfASeUMagUC7gIXxxsBRsaQlOPRlFVLUou~OSgZPY4Qx3u7xnYv0PfmJjFhkxhyvQKXgnRfsF9rMPrLLdTz~ohTwOeNeTtomCP6E0E61gbR2~shyn6fSY4KXb3zpVxpRH-RDBx~MzLdHLO3oI21HfZqbN~aUuPQQFdO11Kmw3rU0HjC5j89eyCjNQ9QhzoMjKGyiA__" style="width: 120px; height: 120px" />
            </div>
          </div>
        `,
    });
  };

  const printPaycode = async (image?: string) => {
    await RNPrint.print({
      html: `
        <div style="display: flex; flex-direction: column; align-items: center; padding-horizontal: 100">
          <p style="font-size: 22px; text-align: center; color: #000; font-weight: bold; margin: 0; margin-bottom: 10px">
            Pay to 
            <br/>
            ${username}@${FLASH_LN_ADDRESS}
          <p style="font-size: 18px; text-align: center; color: #000; margin: 0; margin-bottom: 10px">
            Display this static QR code online or in person to 
            allow anybody to pay ${username.toLowerCase()}.
          </p> 
          <img src="data:image/png;base64, ${image}" style="width: 150px; height: 150px" />
          <p style="font-size: 16px; text-align: center; color: #939998; margin: 0; margin-top: 10px">
            Having trouble scanning this QR code with your wallet? Some wallets do
            not support printed QR codes like this one. Scan with the camera app on
            your phone to be taken to a webpage where you can create a fresh invoice
            for paying from any Lightning wallet.
          </p>
        </div>
      `,
    });
  };

  return {print, printPaycode, printSilently};
};

export default usePrint;
