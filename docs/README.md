# Flash POS Documentation

Welcome to the Flash POS documentation. This directory contains comprehensive documentation for the Flash Point of Sale application - a React Native Bitcoin/Lightning Network payment solution with NFC flashcard integration and advanced rewards system.

## Documentation Structure

### Core Documentation
- **[01. Project Overview](./01-project-overview.md)** - High-level architecture and project description
- **[02. Development Setup](./02-development-setup.md)** - Environment setup and configuration
- **[03. Architecture](./03-architecture.md)** - Technical architecture and design patterns
- **[04. API Integration](./04-api-integration.md)** - GraphQL and external API integrations
- **[05. Screens & Navigation](./05-screens-navigation.md)** - User interface and navigation flow
- **[06. NFC Integration](./06-nfc-integration.md)** - NFC flashcard implementation
- **[07. Rewards System](./07-rewards-system.md)** - Comprehensive rewards documentation including Event Mode
- **[08. Printing System](./08-printing-system.md)** - Receipt printing capabilities
- **[09. State Management](./09-state-management.md)** - Redux store and data flow
- **[10. Testing](./10-testing.md)** - Testing approach and guidelines
- **[11. Deployment](./11-deployment.md)** - Build and deployment process
- **[12. Security](./12-security.md)** - Security features including PIN protection and fraud prevention

## Quick Start

1. Read the [Development Setup](./02-development-setup.md) guide
2. Review the [Project Overview](./01-project-overview.md) for context
3. Check the [Architecture](./03-architecture.md) for technical details
4. Follow screen-specific documentation for feature implementation

## Key Features

### Payment Processing
- ⚡ Bitcoin/Lightning Network payments
- 💵 External payment support (cash/card)
- 💰 Multi-currency with real-time conversion
- 📊 Transaction history tracking

### Customer Engagement
- 📱 NFC flashcard integration
- 🎁 Dynamic rewards system
- 🎉 Event Mode for promotions
- 🔄 Customer loyalty tracking

### Business Operations
- 🧾 Silent receipt printing
- 🔄 Receipt reprinting system
- 🔒 PIN-protected settings
- 📈 Real-time monitoring

### Security Features
- 🔐 4-digit PIN protection
- 🛡️ Fraud prevention
- 💸 Budget controls
- 🔍 Transaction validation

## Technology Stack

- **Framework**: React Native 0.76.6
- **Language**: TypeScript
- **State Management**: Redux Toolkit + Redux Persist
- **API**: Apollo Client GraphQL
- **Navigation**: React Navigation 7
- **Styling**: Styled Components
- **NFC**: react-native-nfc-manager
- **Printing**: Custom native modules
- **Security**: SHA-256 hashing, local encryption

## Recent Updates

### Event Mode (Phase 1)
- Temporary promotional campaigns
- Custom reward rates and limits
- Real-time progress tracking
- Budget and customer controls
- PIN-protected configuration

### Enhanced Security
- Consolidated security documentation
- Improved fraud prevention
- Transaction validation layers
- Comprehensive audit trails

## Getting Help

- Check the relevant documentation section first
- Review code comments and type definitions
- Look at existing implementations for patterns
- Examine test files for usage examples
- Consult the [Security](./12-security.md) guide for best practices

## Contributing

When adding new features:
1. Update relevant documentation
2. Add security considerations
3. Include testing guidelines
4. Follow existing patterns

Last updated: January 2025