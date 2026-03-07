/**
 * CashuProvision.tsx
 *
 * Merchant screen for issuing Flash cards (ENG-177).
 *
 * Flow:
 *   Step 1 — Enter USD amount to load
 *   Step 2 — Enter PIN (merchant sets a provisioning PIN for this card)
 *   Step 3 — Tap card   → NFC session: GET_INFO (verify blank) + GET_PUBKEY
 *   Step 4 — Loading    → calls cashuCardProvision GQL → receives proofs
 *   Step 5 — Writing    → SET_PIN + VERIFY_PIN + LOAD_PROOF × N over NFC
 *   Step 6 — Success    → card is ready to spend
 *
 * For top-up (card already has proofs / PIN set), the user enters the
 * existing PIN and the flow skips SET_PIN → goes straight to VERIFY_PIN.
 */

import React, {useCallback, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {StackScreenProps} from '@react-navigation/stack';
import {useMutation} from '@apollo/client';

import useCashuCard, {CashuCardError} from '../nfc/useCashuCard';
import {
  CASHU_CARD_PROVISION,
  CashuCardProvisionPayload,
  toCardWriteProof,
} from '../graphql/cashu';
import {toastShow} from '../utils/toast';
import {useAppSelector} from '../store/hooks';

type Props = StackScreenProps<RootStackType, 'CashuProvision'>;

// ─────────────────────────────────────────────────────────────────────────────
// Step definitions
// ─────────────────────────────────────────────────────────────────────────────

type Step =
  | 'amount'    // Enter USD amount
  | 'pin'       // Enter provisioning PIN
  | 'tapping'   // NFC — reading card
  | 'minting'   // GQL — minting proofs on backend
  | 'writing'   // NFC — writing proofs to card
  | 'success'   // Done
  | 'error';    // Unrecoverable error

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

const CashuProvision: React.FC<Props> = ({navigation}) => {
  const walletId = useAppSelector(state => state.user.walletId);

  const [step, setStep] = useState<Step>('amount');
  const [amountDisplay, setAmountDisplay] = useState('');   // e.g. "10.00"
  const [pin, setPin] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [progressMessage, setProgressMessage] = useState('');
  const [successInfo, setSuccessInfo] = useState<{
    proofCount: number;
    totalCents: number;
  } | null>(null);

  // Track whether this is a top-up (card has existing PIN) — determined on tap
  const isTopUpRef = useRef(false);

  const card = useCashuCard();

  const [provisionMutation] = useMutation<{
    cashuCardProvision: CashuCardProvisionPayload;
  }>(CASHU_CARD_PROVISION);

  // ─── Amount helpers ───────────────────────────────────────────────────────

  const amountCents = (): number => {
    const val = parseFloat(amountDisplay);
    if (isNaN(val) || val <= 0) return 0;
    return Math.round(val * 100);
  };

  // ─── Main provisioning flow ───────────────────────────────────────────────

  const runProvision = useCallback(
    async (pinValue: string) => {
      try {
        // ── Step 3: NFC tap — read card ──────────────────────────────────
        setStep('tapping');
        setProgressMessage('Hold card to phone…');
        await card.startSession();

        let cardPubkey: string;
        let isBlank: boolean;

        try {
          const {pubkey, info} = await card.readBlankCardPubkey();
          cardPubkey = pubkey;
          isBlank = true;
          isTopUpRef.current = false;
          setProgressMessage(`Card ready (${info.emptyCount} free slots)`);
        } catch (err) {
          if (
            err instanceof CashuCardError &&
            err.message.includes('top-up flow')
          ) {
            // Card has existing data — top-up flow
            isTopUpRef.current = true;
            isBlank = false;
            cardPubkey = await card.getPubkey();
            const info = await card.getInfo();
            if (info.emptyCount === 0) {
              throw new CashuCardError('Card is full — no empty slots available');
            }
            setProgressMessage(`Top-up: ${info.emptyCount} free slots`);
          } else {
            throw err;
          }
        }

        // ── Step 4: Mint proofs via GQL ──────────────────────────────────
        setStep('minting');
        setProgressMessage('Minting proofs…');

        // Get available slot count for top-up denomination split
        let availableSlots: number | undefined;
        if (!isBlank) {
          const info = await card.getInfo();
          availableSlots = info.emptyCount;
        }

        const result = await provisionMutation({
          variables: {
            input: {
              walletId,
              amountCents: amountCents(),
              cardPubkey,
              ...(availableSlots !== undefined && {availableSlots}),
            },
          },
        });

        const payload = result.data?.cashuCardProvision;
        if (!payload) throw new Error('No response from server');

        if (payload.errors?.length > 0) {
          throw new Error(payload.errors[0].message);
        }

        const {proofs, totalAmountCents} = payload;
        if (!proofs || proofs.length === 0) {
          throw new Error('No proofs returned from mint');
        }

        setProgressMessage(`Writing ${proofs.length} proofs to card…`);

        // ── Step 5: Write proofs to card ─────────────────────────────────
        setStep('writing');

        const cardWriteProofs = proofs.map(toCardWriteProof);
        await card.writeProofs(cardWriteProofs, pinValue, isBlank);

        await card.cleanup();

        // ── Step 6: Success ──────────────────────────────────────────────
        setSuccessInfo({
          proofCount: proofs.length,
          totalCents: totalAmountCents,
        });
        setStep('success');

      } catch (err) {
        await card.cleanup();

        const message =
          err instanceof Error ? err.message : 'Unknown NFC error';

        // User cancelled NFC — go back to pin entry
        if (
          message.toLowerCase().includes('cancel') ||
          message.toLowerCase().includes('user cancel')
        ) {
          setStep('pin');
          return;
        }

        setErrorMessage(message);
        setStep('error');
        toastShow({message, type: 'error'});
      }
    },
    [card, provisionMutation, walletId, amountDisplay],
  );

  // ─── UI actions ───────────────────────────────────────────────────────────

  const handleAmountNext = () => {
    const cents = amountCents();
    if (cents < 100) {
      toastShow({message: 'Minimum amount is $1.00', type: 'error'});
      return;
    }
    setStep('pin');
  };

  const handlePinNext = () => {
    if (pin.length < 4) {
      toastShow({message: 'PIN must be at least 4 digits', type: 'error'});
      return;
    }
    runProvision(pin);
  };

  const handleRetry = () => {
    setStep('amount');
    setErrorMessage('');
    setPin('');
  };

  const handleDone = () => {
    navigation.goBack();
  };

  // ─── Render helpers ───────────────────────────────────────────────────────

  const formatCents = (cents: number) =>
    `$${(cents / 100).toFixed(2)} USD`;

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled">

        {/* ── Step 1: Amount ──────────────────────────────────────────── */}
        {step === 'amount' && (
          <View style={styles.section}>
            <Text style={styles.title}>Issue Flash Card</Text>
            <Text style={styles.subtitle}>Enter the amount to load in USD</Text>
            <View style={styles.inputRow}>
              <Text style={styles.currencySymbol}>$</Text>
              <TextInput
                style={styles.amountInput}
                value={amountDisplay}
                onChangeText={setAmountDisplay}
                keyboardType="decimal-pad"
                placeholder="0.00"
                placeholderTextColor="#666"
                maxLength={8}
                autoFocus
              />
            </View>
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={handleAmountNext}>
              <Text style={styles.primaryButtonText}>Next →</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Step 2: PIN ──────────────────────────────────────────────── */}
        {step === 'pin' && (
          <View style={styles.section}>
            <Text style={styles.title}>Set Card PIN</Text>
            <Text style={styles.subtitle}>
              Loading {formatCents(amountCents())} onto card.{'\n'}
              Enter a PIN — the cardholder will need this to authorise future
              top-ups.
            </Text>
            <TextInput
              style={styles.pinInput}
              value={pin}
              onChangeText={setPin}
              keyboardType="numeric"
              secureTextEntry
              placeholder="4–8 digit PIN"
              placeholderTextColor="#666"
              maxLength={8}
              autoFocus
            />
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={handlePinNext}>
              <Text style={styles.primaryButtonText}>Tap Card →</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => setStep('amount')}>
              <Text style={styles.secondaryButtonText}>← Back</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Steps 3–5: In-progress ───────────────────────────────────── */}
        {(step === 'tapping' ||
          step === 'minting' ||
          step === 'writing') && (
          <View style={styles.section}>
            <Text style={styles.title}>
              {step === 'tapping'
                ? '📡 Tap Card'
                : step === 'minting'
                ? '⚙️  Minting'
                : '✍️  Writing'}
            </Text>
            <ActivityIndicator
              size="large"
              color="#FF6600"
              style={styles.spinner}
            />
            <Text style={styles.progressText}>{progressMessage}</Text>
            {step === 'tapping' && (
              <Text style={styles.hint}>
                Hold the Flash card near the top of your phone
              </Text>
            )}
          </View>
        )}

        {/* ── Step 6: Success ──────────────────────────────────────────── */}
        {step === 'success' && successInfo && (
          <View style={styles.section}>
            <Text style={styles.successIcon}>✅</Text>
            <Text style={styles.title}>Card Ready!</Text>
            <Text style={styles.subtitle}>
              Loaded {formatCents(successInfo.totalCents)} across{' '}
              {successInfo.proofCount} proof
              {successInfo.proofCount !== 1 ? 's' : ''}.
            </Text>
            <Text style={styles.hint}>
              The card is now ready for offline payments.
            </Text>
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={handleDone}>
              <Text style={styles.primaryButtonText}>Done</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => {
                setStep('amount');
                setAmountDisplay('');
                setPin('');
                setSuccessInfo(null);
              }}>
              <Text style={styles.secondaryButtonText}>Issue Another</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Error ────────────────────────────────────────────────────── */}
        {step === 'error' && (
          <View style={styles.section}>
            <Text style={styles.errorIcon}>❌</Text>
            <Text style={styles.title}>Something Went Wrong</Text>
            <Text style={styles.errorText}>{errorMessage}</Text>
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={handleRetry}>
              <Text style={styles.primaryButtonText}>Try Again</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={() => navigation.goBack()}>
              <Text style={styles.secondaryButtonText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        )}

      </ScrollView>
    </KeyboardAvoidingView>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 24,
  },
  section: {
    alignItems: 'center',
  },
  title: {
    fontSize: 24,
    fontFamily: 'Outfit-Bold',
    color: '#FFFFFF',
    marginBottom: 12,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 15,
    fontFamily: 'Outfit-Regular',
    color: '#AAAAAA',
    textAlign: 'center',
    marginBottom: 32,
    lineHeight: 22,
  },
  hint: {
    fontSize: 13,
    fontFamily: 'Outfit-Regular',
    color: '#666666',
    textAlign: 'center',
    marginTop: 12,
    lineHeight: 19,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 32,
  },
  currencySymbol: {
    fontSize: 36,
    fontFamily: 'Outfit-Bold',
    color: '#FF6600',
    marginRight: 4,
  },
  amountInput: {
    fontSize: 48,
    fontFamily: 'Outfit-Bold',
    color: '#FFFFFF',
    minWidth: 120,
    textAlign: 'center',
  },
  pinInput: {
    fontSize: 32,
    fontFamily: 'Outfit-Bold',
    color: '#FFFFFF',
    borderBottomWidth: 2,
    borderBottomColor: '#FF6600',
    width: 200,
    textAlign: 'center',
    marginBottom: 32,
    paddingBottom: 8,
    letterSpacing: 12,
  },
  spinner: {
    marginVertical: 32,
  },
  progressText: {
    fontSize: 16,
    fontFamily: 'Outfit-Regular',
    color: '#FFFFFF',
    textAlign: 'center',
  },
  successIcon: {
    fontSize: 64,
    marginBottom: 16,
  },
  errorIcon: {
    fontSize: 64,
    marginBottom: 16,
  },
  errorText: {
    fontSize: 14,
    fontFamily: 'Outfit-Regular',
    color: '#FF4444',
    textAlign: 'center',
    marginBottom: 32,
    lineHeight: 20,
  },
  primaryButton: {
    backgroundColor: '#FF6600',
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 48,
    marginTop: 8,
    width: '100%',
    alignItems: 'center',
  },
  primaryButtonText: {
    fontSize: 17,
    fontFamily: 'Outfit-Bold',
    color: '#FFFFFF',
  },
  secondaryButton: {
    paddingVertical: 14,
    paddingHorizontal: 48,
    marginTop: 8,
    width: '100%',
    alignItems: 'center',
  },
  secondaryButtonText: {
    fontSize: 16,
    fontFamily: 'Outfit-Regular',
    color: '#AAAAAA',
  },
});

export default CashuProvision;
