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
          <div style="display: flex;flex-direction: column;align-items: center;">
            <div style="display: flex;flex-direction: column;align-items: center; margin-bottom: 10px">
              <img src="https://media-hosting.imagekit.io//69348383edcc4f59/LOGO.svg?Expires=1832241872&Key-Pair-Id=K2ZIVPTIP2VGHC&Signature=whr62g6uZealmeC7gPXkUMi~mT37jucBwXKuCGM0TKhh6mxrxh3ZwtZd0g2vFsMmK7fuK0tIY9k~yBVXZptpmwvQFk87P-0KrT0dZf8QU3wuNxdcQkRDAaAvn8vs6qnuYIyMQ35sNaZsHuZxJG2JZNOak5ig1Vd1Ypr4sGAXB2v47uCjultc6w-KlZmp4Bl39EobKWKWNbpggPmDahmCo8AlPbM888qnV2xeOr~CSQm~yvRCOxknWGJJ7Lva3pUaaUTVPLJhUJnFss9S2b1Gzo-6i5tATMrXn2jBnljilAKJS3Vw55mr6IhOK-cwwxDnFR9ZQoyKqxqZzMrZsWWU3Q__" style="width: 150px; height: 150px" />
            </div>
            <div style="display: flex;flex-direction: column;align-items: center;">
              <h2 style="padding: 0; margin: 0; margin-bottom: 15px">Sale completed</h2>
              <h3 style="padding: 0; margin: 0">${
                currency.symbol
              } ${displayAmount}</h3>
              <h3 style="padding: 0; margin: 0; margin-bottom: 15px">≈ ${satAmount} sats</h3>
            </div>
            <div>
              <div style="display: flex;justify-content: space-between;">
                <h4 style="padding: 0; margin: 0">Paid to: </h4>
                <h4 style="padding: 0; margin: 0">${username}</h4>
              </div>
              <div style="display: flex; justify-content: space-between; padding: 0; margin: 0">
                <h4 style="padding: 0; margin: 0; margin-right: 10px;">Paid on: </h4>
                <h4 style="padding: 0; margin: 0">${moment().format('lll')}</h4>
              </div>
              <div style="display: flex;justify-content: space-between;">
                <h4 style="padding: 0; margin: 0">Status: </h4>
                <h4 style="padding: 0; margin: 0">Paid</h4>
              </div>
              <div style="display: flex;justify-content: space-between;">
                <h4 style="padding: 0; margin: 0">Description: </h4>
                <h4 style="padding: 0; margin: 0">${memo || 'none'}</h4>
              </div>
            </div>
          </div>
        `,
    });
  };

  const printPaycode = async (image?: string) => {
    await RNPrint.print({
      html: `
      <div style="display: flex; flex-direction: column; align-items: center; padding-horizontal: 100">
        <h1 style="font-size: 40">Pay ${username}@${FLASH_LN_ADDRESS}</h1>
        <h3 style="font-size: 24; text-align: center; color: #939998">
          Display this static QR code online or in person to 
          <br/>
          allow anybody to pay ${username.toLowerCase()}.
        </h3> 
        <img src="data:image/png;base64, ${image}" style="width:500; height:500"/>
        <p style="font-size: 24; text-align: center; color: #939998">
          Having trouble scanning this QR code with your wallet? Some wallets do
          not support printed QR codes like this one. Scan with the camera app on
          your phone to be taken to a webpage where you can create a fresh invoice
          for paying from any Lightning wallet.
        </p>
      </div>`,
    });
  };

  return {print, printPaycode};
};

export default usePrint;
