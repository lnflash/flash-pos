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
  resetFlashcard: () => void;
}

export const useFlashcard = () => {
  const context: ContextProps = useContext(FlashcardContext);
  return context;
};
