# 🔍 NFC Crash Debugging Guide for Physical Devices

## 📱 **ENHANCED DEBUGGING FEATURES ADDED**

Your app now includes comprehensive debugging capabilities to identify the exact crash point:

### **🎯 On-Screen Debug Panel**
- **Debug step tracking**: Shows current processing step
- **Error tracking**: Displays last error encountered  
- **State monitoring**: Shows all critical values (LNURL, user, currency, etc.)
- **Step counter**: Tracks total debugging steps

### **📊 Console Logging**
- **Detailed step logging**: Every action is logged with timestamps
- **Error context**: Full error messages and stack traces
- **State snapshots**: Complete data dumps at each step

---

## 🔌 **OPTION 1: REMOTE DEBUGGING (RECOMMENDED)**

### **Step 1: Enable USB Debugging**
1. On your **Android device**:
   - Go to **Settings > About Phone**
   - Tap **Build Number** 7 times (enables Developer Options)
   - Go to **Settings > Developer Options**  
   - Enable **USB Debugging**
   - Connect device via USB to your computer

### **Step 2: Connect via ADB**
```bash
# Check if device is connected
adb devices

# Should show your device like:
# ABC123DEF    device
```

### **Step 3: Get Real-Time Logs**
```bash
# Get all React Native logs
adb logcat | grep -i "ReactNativeJS"

# Get only our debug logs
adb logcat | grep "REWARDS DEBUG"

# Get crash logs
adb logcat | grep -E "(FATAL|AndroidRuntime|crash)"
```

### **Step 4: Test NFC Crash**
1. **Start logging** in terminal: `adb logcat | grep "REWARDS DEBUG"`
2. **Open the app** on physical device
3. **Navigate to Rewards** screen (watch debug panel)
4. **Tap NFC card** and observe:
   - Last debug step shown on screen
   - Console logs in terminal
   - Exact point where crash occurs

---

## 📱 **OPTION 2: ON-DEVICE DEBUGGING**

### **Using the Debug Panel**
1. **Watch the debug panel** (top-right corner) during NFC interaction
2. **Note the last step** before crash:
   - `REWARD_START` → Initial setup
   - `CREATING_REQUEST_BODY` → Preparing API call
   - `MAKING_API_REQUEST` → Calling BTCPay server
   - `API_RESPONSE_RECEIVED` → Got server response
   - `CREATING_EXTERNAL_PAYMENT_TRANSACTION` → Transaction creation
   - `NAVIGATION_SUCCESS` → Final step

3. **Check state values**:
   - Rewards: Should be "ON"
   - LNURL: Should be "OK" 
   - Loading: Should be "NO"
   - User: Should show username
   - Currency: Should show currency ID

### **Error Messages**
The app now shows specific error messages:
- `Debug: ERROR_MISSING_LNURL` → NFC setup issue
- `Debug: ERROR_CREATING_TRANSACTION` → Transaction creation failure
- `Debug: CRITICAL_ERROR_IN_ONREWARD` → Main function crash

---

## 🧪 **OPTION 3: PROGRESSIVE TESTING**

### **Test Scenario 1: Standalone Rewards**
1. **Navigate directly** to Rewards screen (bottom navigation)
2. **Check debug panel**: Should show "External: NO"
3. **Tap NFC card**
4. **Expected behavior**: Should work without crash

### **Test Scenario 2: External Payment Rewards**  
1. **Use Keypad** → Enter amount → Press "Give Points"
2. **Check debug panel**: Should show "External: YES"
3. **Tap NFC card**
4. **Expected behavior**: This is where crash likely occurs

### **Test Scenario 3: Lightning Rewards**
1. **Complete Lightning payment** → Navigate to Rewards
2. **Check debug panel**: Should show purchase context
3. **Tap NFC card**  
4. **Expected behavior**: Should work (was working before)

---

## 🚨 **LIKELY CRASH POINTS**

Based on our analysis, the crash is most likely occurring at:

### **Point 1: External Payment Transaction Creation**
- **Debug step**: `CREATING_EXTERNAL_PAYMENT_TRANSACTION`
- **Cause**: Invalid data being passed to transaction helpers
- **Solution**: We added comprehensive validation

### **Point 2: Redux State Access**
- **Debug step**: `CREATING_TRANSACTION_DATA`  
- **Cause**: `currency` or `username` is undefined
- **Solution**: Added null checks and fallbacks

### **Point 3: Navigation Parameter Passing**
- **Debug step**: `PREPARING_NAVIGATION`
- **Cause**: Invalid parameters being passed to RewardsSuccess
- **Solution**: Added safe parameter passing

---

## 📋 **DEBUGGING CHECKLIST**

### **Before Testing:**
- [ ] Physical device connected via USB
- [ ] USB debugging enabled
- [ ] ADB working (`adb devices` shows device)
- [ ] Terminal ready for log capture

### **During Testing:**
- [ ] Debug panel visible on screen
- [ ] Console logs running in terminal
- [ ] Note exact debug step when crash occurs
- [ ] Screenshot debug panel if possible

### **After Crash:**
- [ ] Record last debug step shown
- [ ] Copy terminal logs
- [ ] Note any error messages displayed
- [ ] Test different scenarios (standalone vs external)

---

## 🛠️ **DEBUGGING COMMANDS**

### **Real-Time Log Monitoring**
```bash
# Start comprehensive logging
adb logcat -c && adb logcat | grep -E "(REWARDS DEBUG|ReactNativeJS|FATAL)"

# Filter for just our debug logs  
adb logcat | grep "REWARDS DEBUG"

# Get crash dumps
adb logcat | grep -E "(AndroidRuntime|FATAL)" 
```

### **Log Analysis**
```bash
# Save logs to file
adb logcat > nfc_crash_logs.txt

# Search for specific errors
grep -n "ERROR" nfc_crash_logs.txt
grep -n "CRITICAL" nfc_crash_logs.txt
```

---

## 🎯 **EXPECTED OUTCOMES**

### **If External Payment Transaction Issue:**
- Debug panel shows: `CREATING_EXTERNAL_PAYMENT_TRANSACTION`
- Logs show: Error in transaction creation
- **Solution**: Fix transaction helper validation

### **If Redux State Issue:**
- Debug panel shows: `CREATING_TRANSACTION_DATA`  
- Logs show: Cannot read property of undefined
- **Solution**: Fix null checks for currency/username

### **If Navigation Issue:**
- Debug panel shows: `PREPARING_NAVIGATION`
- Logs show: Navigation parameter error
- **Solution**: Fix parameter passing

### **If API Issue:**
- Debug panel shows: `MAKING_API_REQUEST`
- Logs show: Network or API error
- **Solution**: Fix BTCPay server interaction

---

## 📞 **NEXT STEPS**

1. **Run the debugging** using Option 1 (ADB) or Option 2 (on-device)
2. **Identify the exact crash point** from debug panel and logs
3. **Report back** with:
   - Last debug step before crash
   - Error messages from logs  
   - Debug panel state values
   - Crash scenario (standalone vs external payment)

With this enhanced debugging, we should be able to pinpoint the exact issue and fix it quickly! 🚀

---

**The app now has comprehensive debugging built-in. When you test on your physical device, you'll see exactly where the crash occurs, making it much easier to identify and fix the root cause.** 