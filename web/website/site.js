"use strict";

const examples = {
  tech: [
    ["Run ", { code: "npm install" }, " and set ", { code: "API_BASE_URL" }, " before starting the server."],
    ["启动服务器前，请运行 ", { code: "npm install" }, " 并设置 ", { code: "API_BASE_URL" }, "。"]
  ],
  news: [
    ["“The service will resume on Friday,” the agency said in a statement."],
    ["该机构在声明中说：“服务将于周五恢复。”"]
  ],
  paper: [
    ["The association was modest (", { code: "β = 0.42" }, ", ", { code: "p < 0.05" }, ")."],
    ["两者的关联较弱（", { code: "β = 0.42" }, "，", { code: "p < 0.05" }, "）。"]
  ]
};

const tablist = document.querySelector(".tablist");
const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));

function renderSample(id, parts) {
  const nodes = parts.map((part) => {
    if (typeof part === "string") return document.createTextNode(part);
    const code = document.createElement("code");
    code.textContent = part.code;
    return code;
  });
  document.getElementById(id).replaceChildren(...nodes);
}

function selectTab(tab) {
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
  }
  document.getElementById("example").setAttribute("aria-labelledby", tab.id);
  const [source, target] = examples[tab.dataset.style];
  renderSample("sample-source", source);
  renderSample("sample-target", target);
}

for (const tab of tabs) tab.addEventListener("click", () => selectTab(tab));

tablist.addEventListener("keydown", (event) => {
  const index = tabs.indexOf(event.target);
  const destinations = {
    ArrowLeft: (index + tabs.length - 1) % tabs.length,
    ArrowRight: (index + 1) % tabs.length,
    Home: 0,
    End: tabs.length - 1
  };
  if (index < 0 || !Object.hasOwn(destinations, event.key)) return;
  event.preventDefault();
  const tab = tabs[destinations[event.key]];
  selectTab(tab);
  tab.focus();
});
