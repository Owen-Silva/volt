// VOLT — `volt completions <bash|zsh|fish>`: emit a completion script so the
// CLI feels native in your shell. Pipe the output into your rc file.
const WORDS =
  "ask chat agent review search template compare bench doctor models config sessions help version " +
  "--help --version --model --provider --temp --temperature --max-tokens --system --context " +
  "--diff --clip --name --resume --new --raw --json --no-stream --quiet --sessions " +
  "--template --steps --command-timeout --gate --models --providers --image --no-color --color";

const SCRIPTS = {
  bash: `# volt bash completion
_volt() {
  local cur
  cur="\${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=( $(compgen -W "${WORDS}" -- "$cur") )
}
complete -F _volt volt
`,
  zsh: `#compdef volt
# volt zsh completion (put in a file on your fpath as _volt)
_volt() {
  compadd -- ${WORDS.split(" ").join(" ")}
}
compdef _volt volt
`,
  fish: `# volt fish completion
complete -c volt -f
for w in ${WORDS.split(" ").join(" ")}
  complete -c volt -a "$w"
end
`,
};

export function completionsFor(shell) {
  if (shell && SCRIPTS[shell]) return SCRIPTS[shell];
  if (shell) return null;
  return `usage: volt completions <bash|zsh|fish>

Add to your shell:
  bash:  eval "$(volt completions bash)"
  zsh:   source <(volt completions zsh)
  fish:  volt completions fish | source
`;
}
