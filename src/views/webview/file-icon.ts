import {
  getMaterialFileIcon,
  getMaterialFolderIcon,
} from "@baybreezy/file-extension-icon";

/**
 * Get file icon HTML string (for chips, diff headers, etc.)
 * Returns an <img> tag with base64-encoded Material Icon SVG
 */
export function getFileIconHtml(fileName: string, size = 14): string {
  const iconDataUri = getMaterialFileIcon(fileName);
  return `<img class="file-type-icon" src="${iconDataUri}" width="${size}" height="${size}" alt="" />`;
}

/**
 * Get folder icon HTML string
 */
export function getFolderIconHtml(
  folderName: string,
  isOpen = false,
  size = 14
): string {
  const iconDataUri = getMaterialFolderIcon(folderName, isOpen);
  return `<img class="file-type-icon" src="${iconDataUri}" width="${size}" height="${size}" alt="" />`;
}
