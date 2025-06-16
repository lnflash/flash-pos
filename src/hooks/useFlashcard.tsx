import {useContext} from 'react';
import {TagEvent} from 'react-native-nfc-manager';
import {FlashcardContext} from '../contexts/Flashcard';

interface ContextProps {
  tag?: TagEvent;
  k1?: string;
  callback?: string;
  lnurl?: string;
  balanceInSats?: number;
  transactions?: TransactionList;
  loading?: boolean;
  error?: string;
  isNfcEnabled?: boolean;
  resetFlashcard: () => void;
  setNfcEnabled: (enabled: boolean) => void;
  getCardRewardLnurl: () => string | undefined;
  getAllStoredCards: () => Promise<StoredCardInfo[]>;
  deleteStoredCard: (tagId: string) => Promise<boolean>;
  clearAllStoredCards: () => Promise<boolean>;
}

export const useFlashcard = () => {
  const context: ContextProps = useContext(FlashcardContext);
  return context;
};
