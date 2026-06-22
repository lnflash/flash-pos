import {getSecure, removeSecure, setSecure} from './secureStorage';

const STORED_CARDS_KEY = '@flashcard_stored_cards';
const MAX_STORED_CARDS = 50;

const parseStoredCards = (storedCardsJson: string | null): StoredCardInfo[] => {
  if (!storedCardsJson) {
    return [];
  }

  const parsed = JSON.parse(storedCardsJson);
  return Array.isArray(parsed) ? parsed : [];
};

export async function getAllStoredFlashcards(): Promise<StoredCardInfo[]> {
  try {
    return parseStoredCards(await getSecure(STORED_CARDS_KEY));
  } catch {
    return [];
  }
}

export async function getStoredFlashcard(
  tagId: string,
): Promise<StoredCardInfo | null> {
  const storedCards = await getAllStoredFlashcards();
  return storedCards.find(card => card.tagId === tagId) ?? null;
}

export async function storeFlashcardInfo(
  tagId: string,
  cardLnurl: string,
  cardBalanceInSats?: number,
): Promise<void> {
  const existingCards = await getAllStoredFlashcards();
  const filteredCards = existingCards.filter(card => card.tagId !== tagId);

  const newCardInfo: StoredCardInfo = {
    tagId,
    lnurl: cardLnurl,
    lastSeen: new Date().toISOString(),
    balanceInSats: cardBalanceInSats,
  };

  const limitedCards = [newCardInfo, ...filteredCards].slice(
    0,
    MAX_STORED_CARDS,
  );

  await setSecure(STORED_CARDS_KEY, JSON.stringify(limitedCards));
}

export async function deleteStoredFlashcard(tagId: string): Promise<boolean> {
  try {
    const existingCards = await getAllStoredFlashcards();
    if (existingCards.length === 0) {
      return false;
    }

    const filteredCards = existingCards.filter(card => card.tagId !== tagId);
    await setSecure(STORED_CARDS_KEY, JSON.stringify(filteredCards));
    return true;
  } catch {
    return false;
  }
}

export async function clearStoredFlashcards(): Promise<boolean> {
  try {
    await removeSecure(STORED_CARDS_KEY);
    return true;
  } catch {
    return false;
  }
}
