export const TOKEN_HEADER = "x-proofloop-token";
export const PROJECT_HEADER = "x-proofloop-project";

export function localApiHeaders(token: string, projectId: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    [TOKEN_HEADER]: token,
    [PROJECT_HEADER]: projectId,
  };
}
