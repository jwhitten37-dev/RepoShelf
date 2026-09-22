const FORBIDDEN = new Set(["~", "^", ":", "?", "*", "[", "\\"]);

export function validateBranchName(value: string): string | undefined {
  const branch = value.trim();
  if (branch === "") return "Enter a branch name.";
  if (branch.length > 255) return "Branch names cannot exceed 255 characters.";
  if (
    branch === "@" ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith(".") ||
    branch.endsWith("/") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.includes("//") ||
    branch.split("/").some((component) => component.endsWith(".lock")) ||
    hasForbiddenCharacter(branch)
  ) {
    return "Enter a valid Git branch name.";
  }
  return undefined;
}

function hasForbiddenCharacter(branch: string): boolean {
  return [...branch].some((character) => {
    const code = character.codePointAt(0);
    return (
      code === undefined ||
      code <= 32 ||
      code === 127 ||
      FORBIDDEN.has(character)
    );
  });
}
