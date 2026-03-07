/**
 * CashuPayment.tsx
 *
 * Tap-to-pay settlement screen for Flash card payments (ENG-178).
 * Customer taps their Flash card; merchant receives payment via Lightning.
 *
 * Flow:
 *   waiting  → customer taps card
 *   reading  → NFC: SELECT + GET_INFO + GET_PUBKEY + read unspent proofs
 *   spending → NFC: SPEND_PROOF × N (Schnorr sigs from card)
 *   melting  → API: createMeltQuote + meltProofs at Cashu mint
 *   success  → payment confirmed, navigate to Success
 *   error    → retry or cancel
 *
 * Navigation params:
 *   paymentRequest  bolt11 invoice for the merchant
 *   amountCents     amount in USD cents (for proof selection + display)
 */

import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {StackScreenProps} from '@react-navigation/stack';

import useCashuCard, {CashuCardError} from '../nfc/useCashuCard';
import {
  reconstructP2PKSecret,
  bytesToHex,
  hexToBytes,
  SLOT_UNSPENT,
} from '../nfc/cashu-apdu';
import {
  createMeltQuote,
  meltProofs,
  selectProofsForAmount,
  MeltProofInput,
  MeltError,
} from '../nfc/cashu-melt';
import {sha256Bytes} from '../utils/sha256';
import {toastShow} from '../utils/toast';
import {CASHU_MINT_URL} from '@env';

type Props = StackScreenProps<RootStackType, 'CashuPayment'>;

type Step = 'waiting' | 'reading' | 'spending' | 'melting' | 'success' | 'error';

const CashuPayment: React.FC<Props> = ({navigation, route}) => {
  const {paymentRequest, amountCents} = route.params;
  const mintUrl = CASHU_MINT_URL ?? 'https://forge.flashapp.me';

  const [step, setStep] = useState<Step>('waiting');
  const [progressMsg, setProgressMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [paidCents, setPaidCents] = useState(0);

  const card = useCashuCard();
  const runningRef = useRef(false);

  // ─── Main payment flow ──────────────────────────────────────────────────

  const runPayment = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;

    try {
      // ── 1. NFC: read card ──────────────────────────────────────────────
      setStep('reading');
      setProgressMsg('Reading card…');
      await card.startSession();

      // Get card pubkey (needed to reconstruct P2PK secret for each proof)
      const cardPubkey = await card.getPubkey();
      const info = await card.getInfo();

      if (info.unspentCount === 0) {
        throw new CashuCardError('Card has no unspent proofs');
      }

      // Read all unspent proofs
      const slotStatuses = await card.getSlotStatuses();
      const unspentProofs: {
        slotIndex: number;
        amount: number;
        keysetId: string;
        nonce: string;
        C: string;
      }[] = [];

      for (let i = 0; i < slotStatuses.length; i++) {
        if (slotStatuses[i] === SLOT_UNSPENT) {
          const proof = await card.getProof(i);
          unspentProofs.push({
            slotIndex: proof.slotIndex,
            amount: proof.amount,
            keysetId: proof.keysetId,
            nonce: proof.nonce,
            C: proof.C,
          });
        }
      }

      // Select minimum proofs covering the payment amount
      const {selected, total, overpaymentCents} = selectProofsForAmount(
        unspentProofs,
        amountCents,
      );

      if (selected.length === 0) {
        throw new CashuCardError(
          `Insufficient balance. Card has ${formatCents(unspentProofs.reduce((s, p) => s + p.amount, 0))}, ` +
          `payment needs ${formatCents(amountCents)}`,
        );
      }

      if (overpaymentCents > 0) {
        // For v1: overpayment is accepted — card denominations may not match exactly
        // Future: implement change via /v1/swap before melt
        setProgressMsg(
          `Overpayment: ${formatCents(overpaymentCents)} will be rounded up`,
        );
        await sleep(800);
      }

      // ── 2. NFC: SPEND_PROOF for each selected proof ────────────────────
      setStep('spending');
      setProgressMsg(`Authorising ${selected.length} proof${selected.length !== 1 ? 's' : ''}…`);

      const proofInputs: MeltProofInput[] = [];

      for (let i = 0; i < selected.length; i++) {
        const p = selected[i];
        setProgressMsg(`Signing proof ${i + 1} of ${selected.length}…`);

        // Reconstruct the P2PK secret JSON
        const secretJson = reconstructP2PKSecret(p.nonce, cardPubkey);

        // Hash it — this is the message the card signs
        const msgBytes = sha256Bytes(utf8ToBytes(secretJson));
        const msgArr: number[] = [];
        for (let j = 0; j < msgBytes.length; j++) msgArr.push(msgBytes[j]);

        // SPEND_PROOF → Schnorr signature (64 bytes)
        const sigBytes = await card.spendProof(p.slotIndex, msgArr);
        const sigHex = bytesToHex(sigBytes);

        proofInputs.push({
          id: p.keysetId,
          amount: p.amount,
          secret: secretJson,
          C: p.C,
          witness: JSON.stringify({signatures: [sigHex]}),
        });
      }

      await card.cleanup();

      // ── 3. API: melt proofs at mint ────────────────────────────────────
      setStep('melting');
      setProgressMsg('Creating payment quote…');

      const quote = await createMeltQuote(mintUrl, 'usd', paymentRequest);
      setProgressMsg('Processing payment…');

      const result = await meltProofs(mintUrl, quote.quote, proofInputs);

      if (!result.paid) {
        throw new MeltError('Mint did not confirm payment');
      }

      // ── 4. Success ─────────────────────────────────────────────────────
      setPaidCents(total);
      setStep('success');

      // Short delay then navigate to Success screen
      setTimeout(() => {
        navigation.replace('Success', {
          title: `Payment received: ${formatCents(total)}`,
        });
      }, 1500);

    } catch (err) {
      await card.cleanup();
      runningRef.current = false;

      // User cancelled NFC (tapped away) → allow retry
      const msg = err instanceof Error ? err.message : 'Unknown error';
      if (
        msg.toLowerCase().includes('cancel') ||
        msg.toLowerCase().includes('user cancel')
      ) {
        setStep('waiting');
        return;
      }

      setErrorMsg(msg);
      setStep('error');
      toastShow({message: msg, type: 'error'});
    }
  }, [card, paymentRequest, amountCents, mintUrl, navigation]);

  // Auto-start NFC on mount
  useEffect(() => {
    runPayment();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Helpers ───────────────────────────────────────────────────────────

  const formatCents = (cents: number) => `$${(cents / 100).toFixed(2)}`;

  const handleRetry = () => {
    runningRef.current = false;
    setErrorMsg('');
    setStep('waiting');
    runPayment();
  };

  // ─── Render ───────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>

      {/* Waiting — tap card */}
      {step === 'waiting' && (
        <View style={styles.section}>
          <Text style={styles.nfcIcon}>📡</Text>
          <Text style={styles.title}>Tap Flash Card</Text>
          <Text style={styles.amount}>{formatCents(amountCents)}</Text>
          <Text style={styles.subtitle}>
            Ask the customer to hold their Flash card{'\n'}near the top of the phone
          </Text>
          <TouchableOpacity
            style={styles.cancelButton}
            onPress={() => navigation.goBack()}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Reading / Spending / Melting — in-progress */}
      {(step === 'reading' || step === 'spending' || step === 'melting') && (
        <View style={styles.section}>
          <Text style={styles.title}>
            {step === 'reading'
              ? '📖 Reading card'
              : step === 'spending'
              ? '✍️  Authorising'
              : '⚡ Processing'}
          </Text>
          <ActivityIndicator
            size="large"
            color="#FF6600"
            style={styles.spinner}
          />
          <Text style={styles.progressText}>{progressMsg}</Text>
          <Text style={styles.amount}>{formatCents(amountCents)}</Text>
        </View>
      )}

      {/* Success */}
      {step === 'success' && (
        <View style={styles.section}>
          <Text style={styles.successIcon}>✅</Text>
          <Text style={styles.title}>Payment Received</Text>
          <Text style={styles.amount}>{formatCents(paidCents)}</Text>
        </View>
      )}

      {/* Error */}
      {step === 'error' && (
        <View style={styles.section}>
          <Text style={styles.errorIcon}>❌</Text>
          <Text style={styles.title}>Payment Failed</Text>
          <Text style={styles.errorText}>{errorMsg}</Text>
          <TouchableOpacity style={styles.primaryButton} onPress={handleRetry}>
            <Text style={styles.primaryButtonText}>Try Again</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.cancelButton}
            onPress={() => navigation.goBack()}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      )}

    </View>
  );
};

// ─── Utility (avoid importing Node.js Buffer) ────────────────────────────────

function utf8ToBytes(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push((cp >> 6) | 0xc0, (cp & 0x3f) | 0x80);
    } else if (cp >= 0xd800 && cp <= 0xdbff) {
      const lo = str.charCodeAt(++i);
      cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
      out.push(
        (cp >> 18) | 0xf0,
        ((cp >> 12) & 0x3f) | 0x80,
        ((cp >> 6) & 0x3f) | 0x80,
        (cp & 0x3f) | 0x80,
      );
    } else {
      out.push((cp >> 12) | 0xe0, ((cp >> 6) & 0x3f) | 0x80, (cp & 0x3f) | 0x80);
    }
  }
  const arr = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) arr[i] = out[i];
  return arr;
}

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  section: {
    alignItems: 'center',
    width: '100%',
  },
  nfcIcon: {
    fontSize: 80,
    marginBottom: 24,
  },
  successIcon: {
    fontSize: 80,
    marginBottom: 24,
  },
  errorIcon: {
    fontSize: 80,
    marginBottom: 24,
  },
  title: {
    fontSize: 24,
    fontFamily: 'Outfit-Bold',
    color: '#FFFFFF',
    marginBottom: 8,
    textAlign: 'center',
  },
  amount: {
    fontSize: 48,
    fontFamily: 'Outfit-Bold',
    color: '#FF6600',
    marginVertical: 16,
  },
  subtitle: {
    fontSize: 15,
    fontFamily: 'Outfit-Regular',
    color: '#AAAAAA',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 32,
  },
  spinner: {
    marginVertical: 32,
  },
  progressText: {
    fontSize: 15,
    fontFamily: 'Outfit-Regular',
    color: '#AAAAAA',
    textAlign: 'center',
    marginBottom: 8,
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
  cancelButton: {
    paddingVertical: 14,
    marginTop: 8,
  },
  cancelText: {
    fontSize: 16,
    fontFamily: 'Outfit-Regular',
    color: '#AAAAAA',
  },
});

export default CashuPayment;
