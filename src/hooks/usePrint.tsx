import moment from 'moment';
import RNPrint from 'react-native-print';

// hooks
import {useAppSelector} from '../store/hooks';

// assets
import Logo from '../assets/icons/logo.png';

// env
import {FLASH_LN_ADDRESS} from '@env';

const usePrint = () => {
  const {username} = useAppSelector(state => state.user);
  const {satAmount, displayAmount, currency, memo} = useAppSelector(
    state => state.amount,
  );

  const print = async () => {
    await RNPrint.print({
      html: `
          <div style="display: flex;flex-direction: column;">
            <div style="display: flex;flex-direction: column;align-items: center;">
              <p style="padding: 0; margin: 0; margin-bottom: 15px; font-size: 20px">Sale completed</p>
              <p style="padding: 0; margin: 0">${
                currency.symbol
              } ${displayAmount}</p>
              <p style="padding: 0; margin: 0; margin-bottom: 15px">≈ ${satAmount} sats</p>
            </div>
            <div>
              <div style="display: flex;justify-content: space-between; margin-bottom: 5px">
                <p style="padding: 0; margin: 0">Paid to: </p>
                <p style="padding: 0; margin: 0">${username}</p>
              </div>
              <div style="display: flex; justify-content: space-between; padding: 0; margin: 0; margin-bottom: 5px">
                <p style="padding: 0; margin: 0; margin-right: 10px;">Paid on: </p>
                <p style="padding: 0; margin: 0">${moment().format('lll')}</p>
              </div>
              <div style="display: flex;justify-content: space-between; margin-bottom: 5px">
                <p style="padding: 0; margin: 0">Status: </p>
                <p style="padding: 0; margin: 0">Paid</p>
              </div>
              <div style="display: flex;justify-content: space-between; margin-bottom: 20px">
                <p style="padding: 0; margin: 0">Description: </p>
                <p style="padding: 0; margin: 0">${memo || 'none'}</p>
              </div>
            </div>
            <div >
             <p style="padding: 0; margin: 0; margin-bottom: 5px">Download Flash app: </p>
              <img src="https://media-hosting.imagekit.io//ddd57a9aba244f9f/Flash_App_Download_Link_QR-code.JPG?Expires=1833265096&Key-Pair-Id=K2ZIVPTIP2VGHC&Signature=2IK4KMXsYzqBiBdXiUUWaMp~UVx0ycnC7Q9a7RzIukQBKBG4o0Z3ZhSwKCU33XDgO8juUFsDosCeYLIu8Xi38mkHYTHSafQuBTczHUaTmuQHwor0pUdM-DVuioaaLSAqVB8iRhCMMLR5pRwFagfASeUMagUC7gIXxxsBRsaQlOPRlFVLUou~OSgZPY4Qx3u7xnYv0PfmJjFhkxhyvQKXgnRfsF9rMPrLLdTz~ohTwOeNeTtomCP6E0E61gbR2~shyn6fSY4KXb3zpVxpRH-RDBx~MzLdHLO3oI21HfZqbN~aUuPQQFdO11Kmw3rU0HjC5j89eyCjNQ9QhzoMjKGyiA__" style="width: 150px; height: 150px" />
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

  return {print, printPaycode};
};

export default usePrint;
