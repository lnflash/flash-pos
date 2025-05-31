# Project Overview

## What is Flash POS?

Flash POS is a React Native point-of-sale application designed for Bitcoin and Lightning Network payments. It provides merchants with a modern, mobile-first payment solution that integrates NFC flashcards for seamless customer experiences.

## Core Functionality

### Payment Processing
- **Lightning Network Integration**: Fast, low-fee Bitcoin payments via GraphQL API
- **QR Code Generation**: Dynamic invoice QR codes for customer scanning
- **Real-time Price Conversion**: Live Bitcoin to fiat currency conversion
- **Multi-currency Support**: Multiple fiat currency options

### NFC Flashcard System
- **NFC Card Detection**: Automatic detection and processing of NFC flashcards
- **Balance Tracking**: Real-time flashcard balance display
- **Transaction History**: Recent activity and transaction logs
- **LNURL Integration**: Support for LNURL-withdraw protocol

### Merchant Features
- **Receipt Printing**: Silent printing via native Android/iOS modules
- **Rewards System**: Automated customer rewards via BTCPay Server
- **Profile Management**: Merchant configuration and settings
- **Paycode Generation**: Static payment codes for merchants

## Business Value

### For Merchants
- **Reduced Fees**: Lower transaction costs compared to traditional payment processors
- **Instant Settlement**: Immediate Bitcoin payments without chargebacks
- **Global Reach**: Accept payments from customers worldwide
- **Modern Experience**: Intuitive mobile interface

### For Customers
- **Fast Payments**: Near-instant Lightning Network transactions
- **Low Costs**: Minimal transaction fees
- **Privacy**: Bitcoin's pseudonymous nature
- **Rewards**: Automatic loyalty rewards via flashcards

## Target Users

### Primary Users
- **Small to Medium Merchants**: Coffee shops, retail stores, food vendors
- **Bitcoin-accepting Businesses**: Crypto-forward establishments
- **Mobile Vendors**: Food trucks, market stalls, pop-up shops

### Secondary Users
- **Bitcoin Enthusiasts**: Individuals promoting Bitcoin adoption
- **Point-of-sale Integrators**: Companies building Bitcoin payment solutions
- **Financial Technology Developers**: Teams studying Lightning Network implementations

## Key Differentiators

1. **NFC Integration**: Seamless flashcard payments without app downloads
2. **Silent Printing**: Automatic receipt generation without user prompts
3. **Rewards Automation**: Built-in customer loyalty system
4. **Cross-platform**: Single codebase for Android and iOS
5. **GraphQL Architecture**: Modern API design with real-time subscriptions

## Current State

### Implemented Features ✅
- Complete payment flow (amount entry → invoice → payment → success)
- NFC flashcard detection and balance display
- Rewards system with 21 sats per flashcard tap
- Receipt printing with QR codes
- Multi-currency price conversion
- Profile and settings management
- Tab-based navigation

### Architecture Status ✅
- Redux state management with persistence
- Apollo GraphQL client with WebSocket subscriptions
- React Navigation setup
- Styled Components theming
- TypeScript type safety
- Native module integrations

### Platform Support ✅
- Android build configuration
- iOS build configuration
- Asset linking and fonts
- Platform-specific native modules

## Project Structure

```
flash-pos/
├── src/
│   ├── components/     # Reusable UI components
│   ├── screens/        # Main application screens
│   ├── contexts/       # React Context providers
│   ├── hooks/          # Custom React hooks
│   ├── store/          # Redux state management
│   ├── graphql/        # Apollo client and queries
│   ├── utils/          # Utility functions
│   ├── types/          # TypeScript type definitions
│   └── assets/         # Images, fonts, icons
├── android/            # Android native code
├── ios/                # iOS native code
└── docs/              # Project documentation
```

## Next Steps

### Immediate Priorities
1. **Testing Coverage**: Comprehensive test suite implementation
2. **Error Handling**: Robust error scenarios and recovery
3. **Performance**: Optimization for low-end devices
4. **Security**: Enhanced security audit and hardening

### Future Enhancements
1. **Multi-wallet Support**: Connect to different Lightning wallets
2. **Advanced Analytics**: Transaction reporting and insights
3. **Inventory Management**: Product catalog integration
4. **Multi-merchant**: Support for multiple merchant accounts