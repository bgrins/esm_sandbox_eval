import {
  deleteDirectory,
  deleteFile,
  saveFile,
  getDirectoryStructure,
} from "./opfs-helper.js";

let confirmDialog = null;
let errorDialog = null;
let main = null;
let mainInnerHTML = "";
const mainEmptyHTML = "<span>🫙</span> Origin Private File System is empty.";
const openDirectories = new Set();

let interval = null;

let lastLength = 0;

const readableSize = (size) => {
  if (size === 0) return "0B";
  const i = Math.floor(Math.log(size) / Math.log(1024));
  return `${(size / Math.pow(1024, i)).toFixed(2) * 1} ${
    ["B", "KB", "MB", "GB", "TB"][i]
  }`;
};

const createTreeHTML = (structure, container) => {
  const entries = Object.entries(structure);
  // Sort entries by name and kind.
  entries
    .sort((a, b) => {
      if (a[0] === b[0]) return 0;
      return a[0] < b[0] ? -1 : 1;
    })
    .sort((a, b) => {
      if (a[1].kind === b[1].kind) return 0;
      return a[1].kind < b[1].kind ? -1 : 1;
    });
  for (const [key, value] of entries) {
    if (value.kind === "directory") {
      const details = document.createElement("details");
      container.append(details);
      const summary = document.createElement("summary");
      summary.classList.add("directory");
      details.append(summary);
      if (value.relativePath === ".") {
        details.open = true;
        details.classList.add("root");
        summary.textContent = " ";
      } else {
        details.open = openDirectories.has(value.relativePath);
        details.ontoggle = (event) => {
          if (details.open) {
            openDirectories.add(value.relativePath);
          } else {
            openDirectories.delete(value.relativePath);
          }
        };
        const directoryNameSpan = document.createElement("span");
        directoryNameSpan.classList.add("directory-name");
        directoryNameSpan.textContent = key;
        const deleteSpan = document.createElement("span");
        deleteSpan.textContent = "🗑️";
        deleteSpan.classList.add("delete");
        deleteSpan.addEventListener("click", (event) => {
          confirmDialog.querySelector("span").textContent = "directory";
          confirmDialog.querySelector("code").textContent = key;
          confirmDialog.addEventListener(
            "close",
            (event) => {
              if (confirmDialog.returnValue === "delete") {
                deleteDirectory(value.relativePath);
              }
            },
            { once: true }
          );
          confirmDialog.showModal();
        });
        summary.append(directoryNameSpan, deleteSpan);
      }
      const div = document.createElement("div");
      details.append(div);
      createTreeHTML(value.entries, div);
    } else if (value.kind === "file") {
      const div = document.createElement("div");
      div.classList.add("file");
      div.tabIndex = 0;
      div.title = `Type: ${value.type || "Unknown"} - Last modified: ${new Date(
        value.lastModified
      ).toLocaleString()}`;
      container.append(div);
      const fileNameSpan = document.createElement("span");
      fileNameSpan.classList.add("file-name");
      fileNameSpan.textContent = key;
      fileNameSpan.addEventListener("click", () => {
        saveFile(value);
      });
      const sizeSpan = document.createElement("span");
      sizeSpan.classList.add("size");
      sizeSpan.textContent = readableSize(value.size);
      const deleteSpan = document.createElement("span");
      deleteSpan.textContent = "🗑️";
      deleteSpan.classList.add("delete");
      deleteSpan.addEventListener("click", (event) => {
        confirmDialog.querySelector("span").textContent = "file";
        confirmDialog.querySelector("code").textContent = key;
        confirmDialog.addEventListener(
          "close",
          (event) => {
            if (confirmDialog.returnValue === "delete") {
              deleteFile(value.relativePath);
            }
          },
          { once: true }
        );
        confirmDialog.showModal();
      });
      div.append(fileNameSpan, sizeSpan, deleteSpan);
    }
  }
};

const refreshTree = async () => {
  let response = await getDirectoryStructure();
  if (!response.structure) {
    return;
  }
  // Naive check to avoid unnecessary DOM updates.
  const newLength = JSON.stringify(response.structure).length;
  if (lastLength === newLength) {
    return;
  }
  lastLength = newLength;
  if (Object.keys(response.structure).length === 0) {
    main.innerHTML = mainEmptyHTML;
    return;
  }
  const div = document.createElement("div");
  createTreeHTML(response.structure, div);
  main.innerHTML = "";
  main.append(div);
  main.addEventListener("keydown", (event) => {
    if (event.target.nodeName === "SUMMARY") {
      if (event.key === "ArrowRight") {
        event.target.parentElement.open = true;
      } else if (event.key === "ArrowLeft") {
        event.target.parentElement.open = false;
      }
    }
  });
};
confirmDialog = document.body.querySelector(".confirm-dialog");
errorDialog = document.body.querySelector(".error-dialog");
main = document.body.querySelector("main");
if (!mainInnerHTML) {
  mainInnerHTML = main.innerHTML;
}

lastLength = 0;

refreshTree();
interval = setInterval(refreshTree, 3000);
