#!/bin/bash

# Load environment variables from .env.fastlane
if [ -f .env.fastlane ]; then
  export $(cat .env.fastlane | grep -v '^#' | xargs)
else
  echo "Error: .env.fastlane file not found!"
  echo "Please create it with your credentials."
  exit 1
fi

# Run the deployment
LANE=${1:-beta}

echo "🚀 Deploying iOS to $LANE..."
bundle exec fastlane ios $LANE
