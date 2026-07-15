# Git tracking fixtures

Integration tests create disposable real Git repositories at runtime so staged,
unstaged, untracked, binary, rename, deletion, path encoding, and filesystem race
behavior are exercised against the installed Git implementation without storing
nested repositories in this source tree.
