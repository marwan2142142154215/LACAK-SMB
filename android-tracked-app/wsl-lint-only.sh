#!/bin/bash
set -e
export ANDROID_HOME="$HOME/android-sdk"
export JAVA_HOME=$(dirname $(dirname $(readlink -f $(which java))))
cd "/mnt/c/Users/ACE COMPUTER/Documents/lacak/android-tracked-app"
./gradlew lint --no-daemon -PsiteCode=TEST -PgatewayUrl=http://x -PsiteName=Test
echo "LINT_DONE"
