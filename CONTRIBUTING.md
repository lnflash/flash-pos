# Contributing to Flash POS

Thank you for your interest in contributing to Flash POS! This guide will help you get started.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Pull Request Process](#pull-request-process)
- [Style Guide](#style-guide)
- [Testing](#testing)
- [Documentation](#documentation)
- [Getting Help](#getting-help)

## Code of Conduct

Be respectful, inclusive, and constructive. We're all here to build something great together.

## Getting Started

### Prerequisites

- Node.js >= 18
- Yarn
- Android Studio (for Android development)
- Xcode (for iOS development, macOS only)
- A physical device with NFC for testing NFC features

### Setup

1. **Fork the repository** on GitHub

2. **Clone your fork**:
   ```bash
   git clone https://github.com/YOUR_USERNAME/flash-pos.git
   cd flash-pos
   ```

3. **Add upstream remote**:
   ```bash
   git remote add upstream https://github.com/lnflash/flash-pos.git
   ```

4. **Install dependencies**:
   ```bash
   yarn install
   cd ios && pod install && cd ..  # iOS only
   ```

5. **Configure environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your configuration
   ```

6. **Run the app**:
   ```bash
   yarn start  # Start Metro
   yarn android  # or yarn ios
   ```

## Development Workflow

### Branching Strategy

- `main` — Production-ready code
- `develop` — Integration branch (if used)
- `feature/*` — New features
- `fix/*` — Bug fixes
- `docs/*` — Documentation updates

### Creating a Feature Branch

```bash
# Sync with upstream first
git fetch upstream
git checkout main
git rebase upstream/main

# Create your branch
git checkout -b feature/your-feature-name
```

### Making Changes

1. Make your changes in small, logical commits
2. Write clear commit messages following [Conventional Commits](https://www.conventionalcommits.org/):
   ```
   feat: add NFC card balance display
   fix: resolve crash on empty invoice
   docs: update setup instructions
   refactor: simplify payment flow logic
   test: add unit tests for rewards calculation
   ```

3. Keep commits focused — one logical change per commit

### Staying Up to Date

```bash
git fetch upstream
git rebase upstream/main
```

## Pull Request Process

### Before Submitting

- [ ] Code compiles without errors
- [ ] Tests pass: `yarn test`
- [ ] Linter passes: `yarn lint`
- [ ] TypeScript has no errors
- [ ] You've tested on a real device (if applicable)
- [ ] Documentation is updated (if needed)

### Submitting a PR

1. Push your branch:
   ```bash
   git push origin feature/your-feature-name
   ```

2. Open a Pull Request on GitHub

3. Fill out the PR template:
   - **Description**: What does this PR do?
   - **Related Issue**: Link to any related issues
   - **Testing**: How did you test this?
   - **Screenshots**: Include for UI changes

4. Request review from maintainers

### Review Process

- Maintainers will review within a few days
- Address feedback by pushing additional commits
- Once approved, a maintainer will merge

## Style Guide

### TypeScript

- Use TypeScript for all new code
- Define interfaces for props and state
- Avoid `any` type — use `unknown` if needed
- Use meaningful variable names

```typescript
// Good
interface PaymentProps {
  amount: number;
  currency: string;
  onSuccess: (txId: string) => void;
}

// Avoid
interface Props {
  a: any;
  cb: Function;
}
```

### React Components

- Use functional components with hooks
- Extract reusable logic into custom hooks
- Keep components focused and small

```typescript
// Good: Small, focused component
const AmountDisplay: React.FC<{ sats: number }> = ({ sats }) => {
  const formatted = useSatsFormatter(sats);
  return <Text style={styles.amount}>{formatted}</Text>;
};
```

### File Structure

```
src/
├── components/          # Reusable UI components
│   └── Button/
│       ├── Button.tsx
│       ├── Button.styles.ts
│       └── index.ts
├── screens/             # Full-screen components
├── hooks/               # Custom React hooks
├── utils/               # Pure utility functions
├── types/               # TypeScript type definitions
└── store/               # Redux state management
```

### Styling

- Use Styled Components
- Follow existing color/spacing conventions
- Support both light and dark themes

```typescript
import styled from 'styled-components/native';

const Container = styled.View`
  padding: 16px;
  background-color: ${({ theme }) => theme.colors.background};
`;
```

## Testing

### Running Tests

```bash
# Run all tests
yarn test

# Run with coverage
yarn test --coverage

# Run specific test file
yarn test src/utils/__tests__/currency.test.ts
```

### Writing Tests

- Place tests in `__tests__` directories or `.test.ts` files
- Test behavior, not implementation
- Mock external dependencies

```typescript
describe('formatSats', () => {
  it('formats thousands with comma separator', () => {
    expect(formatSats(1234567)).toBe('1,234,567 sats');
  });

  it('handles zero', () => {
    expect(formatSats(0)).toBe('0 sats');
  });
});
```

## Documentation

### When to Update Docs

- Adding new features
- Changing existing behavior
- Adding new dependencies
- Modifying setup process

### Documentation Files

| File | Purpose |
|------|---------|
| `README.md` | Project overview, quick start |
| `CONTRIBUTING.md` | This file |
| `docs/*.md` | Detailed technical docs |

## Getting Help

- **Questions**: Open a GitHub Discussion
- **Bugs**: Open an Issue with reproduction steps
- **Ideas**: Open an Issue with the `enhancement` label
- **Security**: Email security@flashapp.me (do not open public issues)

## Bounty Program

Some issues have bounty rewards attached. Look for the `💰 bounty` label.

- Bounties are paid in Bitcoin via Lightning
- Payment is made after PR is merged
- See individual issues for bounty amounts
- Follow the [lnflash CONTRIBUTING guidelines](https://github.com/lnflash/.github/blob/main/CONTRIBUTING.md)

---

Thank you for contributing! ⚡
