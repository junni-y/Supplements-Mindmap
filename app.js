(function () {
  "use strict";

  // ==================== 常量与全局状态 ====================
  var SCHEMA_VERSION = 1;
  var DB_NAME = "EssayCardBoxDB";
  var DB_VERSION = 1;
  var STORE_NAME = "cards";

  var db = null;
  var cardsMap = {}; // id -> Card 对象（全量缓存，包括回收站内卡片）

  // 卡片墙筛选与搜索状态
  var wallState = {
    searchQuery: "",
    selectedTags: [],
    tagMode: "AND" // "AND" | "OR"
  };

  // 当前翻卡页状态
  var currentViewState = {
    cardId: null,
    face: "prompt",       // "prompt" | "notes" | "draft"
    notesMode: "edit",    // "edit" | "preview"
    scrollTop: 0
  };

  // 前进/后退历史栈（同步浏览器 history API）
  var navHistory = [];
  var navIndex = -1;
  var isPopStateNavigating = false;

  // 自动补全状态
  var acState = {
    visible: false,
    triggerStart: -1,
    candidates: [],
    selectedIndex: 0
  };

  // 当前正在编辑块绑定的 blockId
  var editingBlockId = null;

  // 待确认导入数据
  var pendingImportPlan = null;

  // ==================== 工具函数 ====================
  function generateId() {
    var ts = Date.now().toString(36);
    var rand = Math.random().toString(36).substring(2, 7);
    return "c_" + ts + "_" + rand;
  }

  function shortId(id) {
    return id ? id.slice(-4) : "";
  }

  function formatTime(ts) {
    if (!ts) return "-";
    var d = new Date(ts);
    var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // 剥离 Markdown 标记，提取纯文本（用于全文检索）
  function stripMarkdown(md) {
    if (!md) return "";
    return md
      .replace(/\[\[([a-zA-Z0-9_-]+)(?:\|[^\]]*)?\]\]/g, function (_, targetId) {
        var c = cardsMap[targetId];
        return c ? (c.prompt || "无题卡片") : "卡片已删除";
      })
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[#>*_`~-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // 剥离富文本 HTML 标签，提取纯文本（用于全文检索与字数统计）
  function stripHtml(html) {
    if (!html) return "";
    var tmp = document.createElement("div");
    tmp.innerHTML = html;
    return (tmp.textContent || tmp.innerText || "").replace(/\u200B/g, "");
  }

  // 获取卡片展示名称（重名时附短 ID）
  function getCardDisplayTitle(cardId) {
    var card = cardsMap[cardId];
    if (!card) return "卡片已删除";
    var rawTitle = (card.prompt || "").trim() || "（未命名题目）";
    var firstLine = rawTitle.split("\n")[0];
    if (firstLine.length > 42) firstLine = firstLine.slice(0, 42) + "...";

    // 检查活跃卡片中是否存在重名
    var duplicateCount = 0;
    Object.keys(cardsMap).forEach(function (id) {
      var c = cardsMap[id];
      if (!c.deletedAt && ((c.prompt || "").trim() || "（未命名题目）") === rawTitle) {
        duplicateCount++;
      }
    });

    if (duplicateCount > 1) {
      return firstLine + " [#" + shortId(card.id) + "]";
    }
    return firstLine;
  }

  // ==================== IndexedDB 持久化层 ====================
  function initDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var database = e.target.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      };
      req.onsuccess = function (e) {
        db = e.target.result;
        resolve(db);
      };
      req.onerror = function (e) {
        reject(e.target.error);
      };
    });
  }

  function loadAllCardsFromDB() {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE_NAME, "readonly");
      var store = tx.objectStore(STORE_NAME);
      var req = store.getAll();
      req.onsuccess = function () {
        cardsMap = {};
        (req.result || []).forEach(function (c) {
          cardsMap[c.id] = normalizeCard(c);
        });
        resolve();
      };
      req.onerror = function (e) {
        reject(e.target.error);
      };
    });
  }

  function normalizeCard(raw) {
    return {
      id: raw.id,
      prompt: typeof raw.prompt === "string" ? raw.prompt : "",
      notesMd: typeof raw.notesMd === "string" ? raw.notesMd : "",
      draftHtml: typeof raw.draftHtml === "string" ? raw.draftHtml : "",
      tags: Array.isArray(raw.tags) ? raw.tags : [],
      relatedCardIds: Array.isArray(raw.relatedCardIds) ? raw.relatedCardIds : [],
      blockBindings: Array.isArray(raw.blockBindings) ? raw.blockBindings : [],
      createdAt: raw.createdAt || Date.now(),
      updatedAt: raw.updatedAt || Date.now(),
      deletedAt: raw.deletedAt || null
    };
  }

  function saveCardToDB(card, updateTimestamp) {
    if (updateTimestamp !== false) {
      card.updatedAt = Date.now();
    }
    cardsMap[card.id] = card;
    showSaveIndicator("保存中...");
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE_NAME, "readwrite");
      var store = tx.objectStore(STORE_NAME);
      var req = store.put(card);
      req.onsuccess = function () {
        showSaveIndicator("已自动保存");
        resolve(card);
      };
      req.onerror = function (e) {
        showSaveIndicator("保存失败！");
        reject(e.target.error);
      };
    });
  }

  function deleteCardPermanentlyFromDB(cardId) {
    delete cardsMap[cardId];
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(STORE_NAME, "readwrite");
      var store = tx.objectStore(STORE_NAME);
      var req = store.delete(cardId);
      req.onsuccess = function () { resolve(); };
      req.onerror = function (e) { reject(e.target.error); };
    });
  }

  function showSaveIndicator(text) {
    var el = document.getElementById("save-indicator");
    if (el) el.textContent = text;
  }

  // ==================== Markdown 切块与稳定块 ID 算法 ====================
  // 规则：按「标题 / 列表项 / 段落」切分，并结合内容哈希与旧绑定进行稳定匹配，避免重排静默丢失
  function computeTextHash(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) {
      h = ((h << 5) + h) + str.charCodeAt(i);
    }
    return (h >>> 0).toString(36);
  }

  function parseMarkdownBlocks(mdText, existingBindings) {
    var lines = (mdText || "").split(/\r?\n/);
    var rawBlocks = [];
    var currentPara = [];

    function flushPara() {
      if (currentPara.length > 0) {
        rawBlocks.push({
          type: "paragraph",
          text: currentPara.join("\n")
        });
        currentPara = [];
      }
    }

    lines.forEach(function (line) {
      var trimmed = line.trim();
      if (trimmed === "") {
        flushPara();
      } else if (/^#{1,6}\s+/.test(trimmed)) {
        flushPara();
        rawBlocks.push({ type: "heading", text: line });
      } else if (/^([-*+]|\d+\.)\s+/.test(trimmed)) {
        flushPara();
        rawBlocks.push({ type: "list_item", text: line });
      } else {
        currentPara.push(line);
      }
    });
    flushPara();

    // 匹配已有块绑定（优先按内容完全匹配，其次按哈希前缀匹配，未匹配到的旧绑定保留为 stale 提示）
    var usedBindingIndices = {};
    var blocks = rawBlocks.map(function (rb, idx) {
      var normText = rb.text.trim();
      var hash = computeTextHash(normText);
      var matchedBinding = null;

      // 1. 精确文本指纹匹配
      for (var i = 0; i < existingBindings.length; i++) {
        if (!usedBindingIndices[i] && existingBindings[i].textHash === hash) {
          usedBindingIndices[i] = true;
          matchedBinding = existingBindings[i];
          break;
        }
      }

      // 2. 若文本微调，尝试前 16 字近似匹配
      if (!matchedBinding && normText.length >= 4) {
        var prefix = normText.slice(0, 16);
        for (var j = 0; j < existingBindings.length; j++) {
          if (!usedBindingIndices[j] && existingBindings[j].textSnapshot &&
              existingBindings[j].textSnapshot.indexOf(prefix) === 0) {
            usedBindingIndices[j] = true;
            matchedBinding = existingBindings[j];
            matchedBinding.textHash = hash;
            matchedBinding.textSnapshot = normText.slice(0, 60);
            break;
          }
        }
      }

      var blockId = matchedBinding ? matchedBinding.blockId : ("blk_" + hash + "_" + idx);
      return {
        blockId: blockId,
        type: rb.type,
        text: rb.text,
        textHash: hash,
        binding: matchedBinding
      };
    });

    // 收集未能匹配到当前正文的旧绑定（标为待重新绑定，绝不静默丢弃）
    var staleBindings = [];
    for (var k = 0; k < existingBindings.length; k++) {
      if (!usedBindingIndices[k]) {
        staleBindings.push(existingBindings[k]);
      }
    }

    return { blocks: blocks, staleBindings: staleBindings };
  }

  // ==================== 统一引用关系与双向回链推导引擎 ====================
  // 正向引用与反向回链全部由同一份数据实时推导，避免双写不同步
  function extractForwardRefsFromCard(card) {
    var refs = [];
    if (!card || card.deletedAt) return refs;

    // 1. 正文链接 [[cardId]]
    var linkRegex = /\[\[([a-zA-Z0-9_-]+)(?:\|[^\]]*)?\]\]/g;
    var match;
    while ((match = linkRegex.exec(card.notesMd || "")) !== null) {
      refs.push({
        sourceCardId: card.id,
        targetCardId: match[1],
        type: "正文链接"
      });
    }

    // 2. 块绑定
    (card.blockBindings || []).forEach(function (b) {
      if (b.targetCardId) {
        refs.push({
          sourceCardId: card.id,
          targetCardId: b.targetCardId,
          type: "块绑定"
        });
      }
    });

    // 3. 底部相关卡片清单
    (card.relatedCardIds || []).forEach(function (targetId) {
      refs.push({
        sourceCardId: card.id,
        targetCardId: targetId,
        type: "关联列表"
      });
    });

    return refs;
  }

  function getBacklinksForCard(targetCardId) {
    var backlinks = [];
    Object.keys(cardsMap).forEach(function (id) {
      var sourceCard = cardsMap[id];
      if (!sourceCard || sourceCard.deletedAt || sourceCard.id === targetCardId) return;

      var forwardRefs = extractForwardRefsFromCard(sourceCard);
      // 同一张来源卡的同一种引用类型去重展示
      var seenTypes = {};
      forwardRefs.forEach(function (ref) {
        if (ref.targetCardId === targetCardId && !seenTypes[ref.type]) {
          seenTypes[ref.type] = true;
          backlinks.push({
            sourceCardId: sourceCard.id,
            type: ref.type
          });
        }
      });
    });
    return backlinks;
  }

  // ==================== 视图 1：卡片墙渲染与检索 ====================
  function getActiveCards() {
    return Object.keys(cardsMap)
      .map(function (id) { return cardsMap[id]; })
      .filter(function (c) { return !c.deletedAt; })
      .sort(function (a, b) { return b.updatedAt - a.updatedAt; });
  }

  function getTrashedCards() {
    return Object.keys(cardsMap)
      .map(function (id) { return cardsMap[id]; })
      .filter(function (c) { return !!c.deletedAt; })
      .sort(function (a, b) { return b.deletedAt - a.deletedAt; });
  }

  function renderWall() {
    var activeCards = getActiveCards();
    var trashedCards = getTrashedCards();
    document.getElementById("trash-count").textContent = trashedCards.length;

    // 收集所有标签
    var tagCounts = {};
    activeCards.forEach(function (c) {
      (c.tags || []).forEach(function (t) {
        tagCounts[t] = (tagCounts[t] || 0) + 1;
      });
    });

    // 渲染标签筛选区
    var wallTagList = document.getElementById("wall-tag-list");
    wallTagList.innerHTML = "";
    var allTags = Object.keys(tagCounts).sort();

    // 清理已不存在的选中标签
    wallState.selectedTags = wallState.selectedTags.filter(function (t) {
      return tagCounts[t] > 0;
    });

    if (allTags.length === 0) {
      wallTagList.innerHTML = '<span class="hint">暂无标签（可在卡片内添加）</span>';
    } else {
      allTags.forEach(function (tag) {
        var pill = document.createElement("span");
        var isSelected = wallState.selectedTags.indexOf(tag) !== -1;
        pill.className = "tag-pill" + (isSelected ? " selected" : "");
        pill.innerHTML = escapeHtml(tag) + " (" + tagCounts[tag] + ') <span class="tag-del" title="全局删除此标签">×</span>';

        pill.addEventListener("click", function (e) {
          if (e.target.classList.contains("tag-del")) {
            e.stopPropagation();
            deleteTagGlobally(tag);
            return;
          }
          var idx = wallState.selectedTags.indexOf(tag);
          if (idx === -1) {
            wallState.selectedTags.push(tag);
          } else {
            wallState.selectedTags.splice(idx, 1);
          }
          renderWall();
        });
        wallTagList.appendChild(pill);
      });
    }

    // 过滤与全文搜索
    var query = wallState.searchQuery.trim().toLowerCase();
    var results = [];

    activeCards.forEach(function (card) {
      // 1. 标签过滤
      if (wallState.selectedTags.length > 0) {
        var cardTags = card.tags || [];
        if (wallState.tagMode === "AND") {
          var hasAll = wallState.selectedTags.every(function (t) { return cardTags.indexOf(t) !== -1; });
          if (!hasAll) return;
        } else {
          var hasAny = wallState.selectedTags.some(function (t) { return cardTags.indexOf(t) !== -1; });
          if (!hasAny) return;
        }
      }

      // 2. 全文检索（题目 + 笔记纯文本 + 成稿纯文本 + 标签名；不搜块ID与关联目标ID）
      if (!query) {
        results.push({ card: card, hit: null });
        return;
      }

      var hit = findSearchHit(card, query);
      if (hit) {
        results.push({ card: card, hit: hit });
      }
    });

    // 状态提示条
    var statusBar = document.getElementById("search-status-bar");
    if (query || wallState.selectedTags.length > 0) {
      statusBar.classList.remove("hidden");
      statusBar.textContent = "共筛选出 " + results.length + " 张卡片" +
        (query ? "（点击卡片将直达命中面）" : "");
    } else {
      statusBar.classList.add("hidden");
    }

    // 渲染卡片列表
    var grid = document.getElementById("card-grid");
    grid.innerHTML = "";

    if (results.length === 0) {
      grid.innerHTML = '<div class="hint" style="grid-column:1/-1;text-align:center;padding:40px;">没有匹配的卡片，点击右上角「+ 新建卡片」开始。</div>';
      return;
    }

    results.forEach(function (item) {
      var card = item.card;
      var hit = item.hit;
      var el = document.createElement("div");
      el.className = "card-item";

      var titleText = getCardDisplayTitle(card.id);
      var draftChars = stripHtml(card.draftHtml).length;
      var backlinkCount = getBacklinksForCard(card.id).length;

      var tagsHtml = (card.tags || []).map(function (t) {
        return '<span class="tag-pill">' + escapeHtml(t) + "</span>";
      }).join("");

      var hitHtml = "";
      if (hit) {
        hitHtml = '<div class="search-hit-box"><span class="search-hit-badge">命中' +
          hit.label + "</span>" + escapeHtml(hit.snippet) + "</div>";
      }

      el.innerHTML =
        '<div>' +
          '<div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:6px;">' +
            '<div class="card-item-title">' + escapeHtml(titleText) + '</div>' +
            '<span class="card-item-id">#' + shortId(card.id) + '</span>' +
          '</div>' +
          hitHtml +
          '<div class="tag-pills" style="margin-top:8px;">' + tagsHtml + '</div>' +
        '</div>' +
        '<div class="card-item-footer">' +
          '<span>成稿 ' + draftChars + ' 字 · 被引用 ' + backlinkCount + '</span>' +
          '<span>' + formatTime(card.updatedAt) + '</span>' +
        '</div>';

      el.addEventListener("click", function () {
        var targetFace = hit ? hit.face : "prompt";
        openCard(card.id, targetFace, "edit", true);
      });

      grid.appendChild(el);
    });
  }

  function findSearchHit(card, lowerQuery) {
    function makeSnippet(text, idx) {
      var start = Math.max(0, idx - 16);
      var end = Math.min(text.length, idx + lowerQuery.length + 24);
      return (start > 0 ? "..." : "") + text.slice(start, end) + (end < text.length ? "..." : "");
    }

    // 1. 题目（问题面）
    var promptText = card.prompt || "";
    var pIdx = promptText.toLowerCase().indexOf(lowerQuery);
    if (pIdx !== -1) {
      return { face: "prompt", label: "题目", snippet: makeSnippet(promptText, pIdx) };
    }

    // 2. 笔记纯文本（笔记面）
    var notesPlain = stripMarkdown(card.notesMd || "");
    var nIdx = notesPlain.toLowerCase().indexOf(lowerQuery);
    if (nIdx !== -1) {
      return { face: "notes", label: "笔记", snippet: makeSnippet(notesPlain, nIdx) };
    }

    // 3. 成稿纯文本（成稿面）
    var draftPlain = stripHtml(card.draftHtml || "");
    var dIdx = draftPlain.toLowerCase().indexOf(lowerQuery);
    if (dIdx !== -1) {
      return { face: "draft", label: "成稿", snippet: makeSnippet(draftPlain, dIdx) };
    }

    // 4. 标签名
    var tags = card.tags || [];
    for (var i = 0; i < tags.length; i++) {
      if (tags[i].toLowerCase().indexOf(lowerQuery) !== -1) {
        return { face: "prompt", label: "标签", snippet: "#" + tags[i] };
      }
    }

    return null;
  }

  // 删除某个标签 = 从所有卡片上解绑该标签，不删卡片
  function deleteTagGlobally(tagToDelete) {
    if (!confirm('确定要从所有卡片上移除标签「' + tagToDelete + '」吗？（不会删除卡片本身）')) return;
    var promises = [];
    Object.keys(cardsMap).forEach(function (id) {
      var c = cardsMap[id];
      if (c.tags && c.tags.indexOf(tagToDelete) !== -1) {
        c.tags = c.tags.filter(function (t) { return t !== tagToDelete; });
        promises.push(saveCardToDB(c, false));
      }
    });
    Promise.all(promises).then(function () {
      renderWall();
    });
  }

  // ==================== 视图 2：翻卡页与历史栈 ====================
  function switchToWallView() {
    document.getElementById("card-view").classList.add("hidden");
    document.getElementById("wall-view").classList.remove("hidden");
    currentViewState.cardId = null;
    renderWall();
  }

  function openCard(cardId, face, notesMode, pushHistory) {
    var card = cardsMap[cardId];
    if (!card || card.deletedAt) {
      alert("该卡片不存在或已移入回收站。");
      return;
    }

    // 保存当前卡片的滚动位置到历史栈顶部
    if (navIndex >= 0 && navHistory[navIndex]) {
      navHistory[navIndex].scrollTop = window.scrollY || 0;
    }

    currentViewState.cardId = cardId;
    currentViewState.face = face || "prompt";
    currentViewState.notesMode = notesMode || "edit";

    if (pushHistory && !isPopStateNavigating) {
      // 截断前进栈
      navHistory = navHistory.slice(0, navIndex + 1);
      navHistory.push({
        cardId: cardId,
        face: currentViewState.face,
        notesMode: currentViewState.notesMode,
        scrollTop: 0
      });
      navIndex = navHistory.length - 1;
      try {
        window.history.pushState({ navIndex: navIndex }, "", "#card=" + cardId);
      } catch (e) {
        // 某些受限环境忽略 pushState 异常
      }
    }

    document.getElementById("wall-view").classList.add("hidden");
    document.getElementById("card-view").classList.remove("hidden");
    updateBackHistoryButton();
    renderCardWorkspace();
  }

  function goBackInCardHistory() {
    if (navIndex <= 0) return;
    // 保存当前面状态
    if (navHistory[navIndex]) {
      navHistory[navIndex].face = currentViewState.face;
      navHistory[navIndex].notesMode = currentViewState.notesMode;
      navHistory[navIndex].scrollTop = window.scrollY || 0;
    }
    navIndex--;
    var prev = navHistory[navIndex];
    if (prev && cardsMap[prev.cardId] && !cardsMap[prev.cardId].deletedAt) {
      isPopStateNavigating = true;
      openCard(prev.cardId, prev.face, prev.notesMode, false);
      window.scrollTo(0, prev.scrollTop || 0);
      isPopStateNavigating = false;
    } else {
      // 如果上一卡已被删，继续往前找
      goBackInCardHistory();
    }
  }

  function updateBackHistoryButton() {
    var btn = document.getElementById("back-history-btn");
    btn.disabled = navIndex <= 0;
  }

  function switchFace(newFace) {
    currentViewState.face = newFace;
    if (navIndex >= 0 && navHistory[navIndex]) {
      navHistory[navIndex].face = newFace;
    }
    renderCardWorkspace();
  }

  function renderCardWorkspace() {
    var card = cardsMap[currentViewState.cardId];
    if (!card) return;

    // 1. 顶部三面 Tab 高亮
    document.querySelectorAll(".face-tab").forEach(function (tab) {
      tab.classList.toggle("active", tab.getAttribute("data-face") === currentViewState.face);
    });

    // 2. 切换三面容器显隐
    document.getElementById("face-prompt").classList.toggle("hidden", currentViewState.face !== "prompt");
    document.getElementById("face-notes").classList.toggle("hidden", currentViewState.face !== "notes");
    document.getElementById("face-draft").classList.toggle("hidden", currentViewState.face !== "draft");

    // 3. 渲染卡片标签与时间戳
    renderCardTags(card);
    document.getElementById("card-timestamps").textContent =
      "ID: " + card.id + " · 创建于 " + formatTime(card.createdAt) + " · 更新于 " + formatTime(card.updatedAt);

    // 4. 填充三面各自独立数据
    if (currentViewState.face === "prompt") {
      document.getElementById("prompt-editor").value = card.prompt;
    } else if (currentViewState.face === "notes") {
      renderNotesFace(card);
    } else if (currentViewState.face === "draft") {
      var draftEditor = document.getElementById("draft-editor");
      if (draftEditor.innerHTML !== card.draftHtml) {
        draftEditor.innerHTML = card.draftHtml;
      }
      updateDraftCharCount();
    }
  }

  function renderCardTags(card) {
    var container = document.getElementById("card-tags-container");
    container.innerHTML = "";
    (card.tags || []).forEach(function (tag) {
      var pill = document.createElement("span");
      pill.className = "tag-pill";
      pill.innerHTML = escapeHtml(tag) + ' <span class="tag-del" title="移除标签">×</span>';
      pill.querySelector(".tag-del").addEventListener("click", function () {
        card.tags = card.tags.filter(function (t) { return t !== tag; });
        saveCardToDB(card);
        renderCardTags(card);
      });
      container.appendChild(pill);
    });
  }

  // ==================== ② 笔记面：编辑态 / 预览态 / 块绑定 / 双向回链 ====================
  function renderNotesFace(card) {
    var isEdit = currentViewState.notesMode === "edit";
    document.getElementById("notes-edit-mode-btn").classList.toggle("active", isEdit);
    document.getElementById("notes-preview-mode-btn").classList.toggle("active", !isEdit);

    document.getElementById("notes-editor-wrapper").classList.toggle("hidden", !isEdit);
    document.getElementById("notes-preview-wrapper").classList.toggle("hidden", isEdit);

    if (isEdit) {
      document.getElementById("notes-editor").value = card.notesMd;
    } else {
      renderNotesPreviewBlocks(card);
    }

    renderRelatedCardsSection(card);
    renderBacklinksSidebar(card);
  }

  function renderNotesPreviewBlocks(card) {
    var wrapper = document.getElementById("notes-preview-wrapper");
    wrapper.innerHTML = "";

    var parsed = parseMarkdownBlocks(card.notesMd, card.blockBindings || []);
    // 同步更新已匹配块的最新指纹，但不丢弃 staleBindings
    var updatedBindings = [];
    parsed.blocks.forEach(function (b) {
      if (b.binding) {
        b.binding.blockId = b.blockId;
        b.binding.textHash = b.textHash;
        b.binding.textSnapshot = b.text.trim().slice(0, 60);
        updatedBindings.push(b.binding);
      }
    });
    parsed.staleBindings.forEach(function (sb) {
      updatedBindings.push(sb);
    });
    card.blockBindings = updatedBindings;

    if (parsed.blocks.length === 0 && parsed.staleBindings.length === 0) {
      wrapper.innerHTML = '<div class="hint">笔记内容为空，切换到「编辑态」开始书写。</div>';
      return;
    }

    parsed.blocks.forEach(function (block) {
      var blockEl = document.createElement("div");
      blockEl.className = "md-block";

      // 渲染基础 Markdown 文本与 [[cardId]] 链接
      var contentHtml = renderInlineMarkdown(block.text);
      var contentDiv = document.createElement("div");
      contentDiv.innerHTML = contentHtml;
      blockEl.appendChild(contentDiv);

      // 绑定 WikiLink 点击跳转（落目标卡笔记面·预览态）
      contentDiv.querySelectorAll(".wiki-link[data-target-id]").forEach(function (linkEl) {
        linkEl.addEventListener("click", function () {
          var targetId = linkEl.getAttribute("data-target-id");
          openCard(targetId, "notes", "preview", true);
        });
      });

      // 块级绑定控制栏
      var toolbar = document.createElement("div");
      toolbar.className = "md-block-toolbar";

      if (block.binding && block.binding.targetCardId) {
        var targetCard = cardsMap[block.binding.targetCardId];
        var isTargetDeleted = !targetCard || !!targetCard.deletedAt;

        var badge = document.createElement("span");
        badge.className = "block-bind-badge" + (isTargetDeleted ? " deleted" : "");
        badge.textContent = isTargetDeleted
          ? "↗ 块绑定：卡片已删除"
          : "↗ 块绑定：" + getCardDisplayTitle(block.binding.targetCardId);

        if (!isTargetDeleted) {
          badge.title = "点击跳转到目标卡片笔记面";
          badge.addEventListener("click", function () {
            openCard(block.binding.targetCardId, "notes", "preview", true);
          });
        }
        toolbar.appendChild(badge);
      }

      var bindBtn = document.createElement("button");
      bindBtn.className = "btn-ghost btn-sm";
      bindBtn.textContent = block.binding ? "修改块绑定" : "+ 绑定卡片";
      bindBtn.addEventListener("click", function () {
        openBlockBindModal(block);
      });
      toolbar.appendChild(bindBtn);

      blockEl.appendChild(toolbar);
      wrapper.appendChild(blockEl);
    });

    // 若正文重排导致部分旧块绑定未能自动匹配，展示「待重新绑定」警告区，绝不静默丢失
    if (parsed.staleBindings.length > 0) {
      var staleBox = document.createElement("div");
      staleBox.style.marginTop = "16px";
      staleBox.style.padding = "12px";
      staleBox.style.background = "#fef3c7";
      staleBox.style.borderRadius = "6px";
      staleBox.innerHTML = "<strong style='font-size:13px;color:#92400e;'>⚠ 检测到因正文重排而失配的块绑定（待重新绑定）：</strong>";

      parsed.staleBindings.forEach(function (sb) {
        var row = document.createElement("div");
        row.style.marginTop = "8px";
        row.style.fontSize = "13px";
        row.style.display = "flex";
        row.style.justifyContent = "space-between";
        row.style.alignItems = "center";

        var targetTitle = getCardDisplayTitle(sb.targetCardId);
        row.innerHTML = '<span>原段落：「' + escapeHtml(sb.textSnapshot || "未知段落") +
          '」 → 绑定至 <b>' + escapeHtml(targetTitle) + "</b></span>";

        var delStaleBtn = document.createElement("button");
        delStaleBtn.className = "btn-danger btn-sm";
        delStaleBtn.textContent = "移除此旧绑定";
        delStaleBtn.addEventListener("click", function () {
          card.blockBindings = card.blockBindings.filter(function (b) { return b.blockId !== sb.blockId; });
          saveCardToDB(card);
          renderNotesPreviewBlocks(card);
          renderBacklinksSidebar(card);
        });
        row.appendChild(delStaleBtn);
        staleBox.appendChild(row);
      });

      wrapper.appendChild(staleBox);
    }
  }

  // 渲染行内 Markdown 与 [[cardId]] 引用
  function renderInlineMarkdown(text) {
    var html = escapeHtml(text);

    // 标题渲染
    if (/^###\s+/.test(html)) {
      html = "<h4>" + html.replace(/^###\s+/, "") + "</h4>";
    } else if (/^##\s+/.test(html)) {
      html = "<h3>" + html.replace(/^##\s+/, "") + "</h3>";
    } else if (/^#\s+/.test(html)) {
      html = "<h2>" + html.replace(/^#\s+/, "") + "</h2>";
    } else if (/^[-*+]\s+/.test(html)) {
      html = "• " + html.replace(/^[-*+]\s+/, "");
    }

    // 粗体与斜体
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");

    // [[cardId]] 引用渲染（显示最新题目，彻底删除后显示「卡片已删除」占位）
    html = html.replace(/\[\[([a-zA-Z0-9_-]+)(?:\|[^\]]*)?\]\]/g, function (_, targetId) {
      var targetCard = cardsMap[targetId];
      if (!targetCard || targetCard.deletedAt) {
        return '<span class="wiki-link deleted" title="目标卡片已删除或位于回收站">[[卡片已删除]]</span>';
      }
      var title = escapeHtml(getCardDisplayTitle(targetId));
      return '<span class="wiki-link" data-target-id="' + targetId + '">[[' + title + "]]</span>";
    });

    return html.replace(/\n/g, "<br>");
  }

  // ==================== [[ 自动补全选卡 ====================
  function handleNotesEditorInput(e) {
    var textarea = e.target;
    var card = cardsMap[currentViewState.cardId];
    if (!card) return;

    card.notesMd = textarea.value;
    saveCardToDB(card);

    var cursorPos = textarea.selectionStart;
    var textBeforeCursor = textarea.value.slice(0, cursorPos);
    var lastOpenBrackets = textBeforeCursor.lastIndexOf("[[");

    if (lastOpenBrackets !== -1) {
      var queryAfterBrackets = textBeforeCursor.slice(lastOpenBrackets + 2);
      // 如果中间没有换行和闭合 ]]，触发自动补全
      if (queryAfterBrackets.indexOf("\n") === -1 && queryAfterBrackets.indexOf("]]") === -1) {
        showAutocomplete(lastOpenBrackets, queryAfterBrackets);
        return;
      }
    }
    hideAutocomplete();
  }

  function showAutocomplete(triggerStart, query) {
    var lowerQ = query.trim().toLowerCase();
    var candidates = getActiveCards().filter(function (c) {
      if (c.id === currentViewState.cardId) return false;
      var title = getCardDisplayTitle(c.id).toLowerCase();
      return !lowerQ || title.indexOf(lowerQ) !== -1 || c.id.toLowerCase().indexOf(lowerQ) !== -1;
    });

    acState.visible = true;
    acState.triggerStart = triggerStart;
    acState.candidates = candidates;
    acState.selectedIndex = 0;

    var popup = document.getElementById("autocomplete-popup");
    popup.innerHTML = "";

    if (candidates.length === 0) {
      popup.innerHTML = '<div class="ac-item" style="color:#94a3b8;">无匹配的活跃卡片</div>';
    } else {
      candidates.forEach(function (c, idx) {
        var item = document.createElement("div");
        item.className = "ac-item" + (idx === 0 ? " active" : "");
        item.textContent = getCardDisplayTitle(c.id);
        item.addEventListener("mousedown", function (ev) {
          ev.preventDefault();
          insertAutocompleteCard(c.id);
        });
        popup.appendChild(item);
      });
    }
    popup.classList.remove("hidden");
  }

  function hideAutocomplete() {
    acState.visible = false;
    document.getElementById("autocomplete-popup").classList.add("hidden");
  }

  function insertAutocompleteCard(targetCardId) {
    var textarea = document.getElementById("notes-editor");
    var val = textarea.value;
    var cursorPos = textarea.selectionStart;
    var before = val.slice(0, acState.triggerStart);
    var after = val.slice(cursorPos);
    var insertion = "[[" + targetCardId + "]]";

    textarea.value = before + insertion + after;
    var newCursor = before.length + insertion.length;
    textarea.setSelectionRange(newCursor, newCursor);
    textarea.focus();

    var card = cardsMap[currentViewState.cardId];
    if (card) {
      card.notesMd = textarea.value;
      saveCardToDB(card);
    }
    hideAutocomplete();
  }

  // ==================== 块绑定弹窗逻辑 ====================
  function openBlockBindModal(block) {
    editingBlockId = block.blockId;
    document.getElementById("block-bind-preview-text").textContent = block.text;

    var select = document.getElementById("block-target-select");
    select.innerHTML = '<option value="">-- 请选择目标卡片 --</option>';
    getActiveCards().forEach(function (c) {
      if (c.id === currentViewState.cardId) return;
      var opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = getCardDisplayTitle(c.id);
      if (block.binding && block.binding.targetCardId === c.id) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });

    // 保存当前块的元数据供确认时写入
    select.dataset.textHash = block.textHash;
    select.dataset.textSnapshot = block.text.trim().slice(0, 60);

    document.getElementById("block-bind-modal").classList.remove("hidden");
  }

  // ==================== 底部相关卡片清单与双向回链 ====================
  function renderRelatedCardsSection(card) {
    var select = document.getElementById("related-card-select");
    select.innerHTML = '<option value="">-- 选择要关联的卡片 --</option>';
    getActiveCards().forEach(function (c) {
      if (c.id === card.id) return;
      if ((card.relatedCardIds || []).indexOf(c.id) !== -1) return;
      var opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = getCardDisplayTitle(c.id);
      select.appendChild(opt);
    });

    var list = document.getElementById("related-cards-list");
    list.innerHTML = "";
    var relatedIds = card.relatedCardIds || [];

    if (relatedIds.length === 0) {
      list.innerHTML = '<li class="hint" style="background:transparent;border:none;padding:4px 0;">暂无手动关联卡片</li>';
      return;
    }

    relatedIds.forEach(function (targetId) {
      var targetCard = cardsMap[targetId];
      var isDeleted = !targetCard || !!targetCard.deletedAt;

      var li = document.createElement("li");
      var titleSpan = document.createElement("span");
      titleSpan.className = "link-title" + (isDeleted ? " deleted" : "");
      titleSpan.textContent = isDeleted ? "卡片已删除" : getCardDisplayTitle(targetId);

      if (!isDeleted) {
        titleSpan.addEventListener("click", function () {
          openCard(targetId, "notes", "preview", true);
        });
      }

      var removeBtn = document.createElement("button");
      removeBtn.className = "btn-ghost btn-sm";
      removeBtn.textContent = "移除";
      removeBtn.addEventListener("click", function () {
        card.relatedCardIds = card.relatedCardIds.filter(function (id) { return id !== targetId; });
        saveCardToDB(card);
        renderRelatedCardsSection(card);
      });

      li.appendChild(titleSpan);
      li.appendChild(removeBtn);
      list.appendChild(li);
    });
  }

  function renderBacklinksSidebar(card) {
    var list = document.getElementById("backlinks-list");
    list.innerHTML = "";
    var backlinks = getBacklinksForCard(card.id);

    if (backlinks.length === 0) {
      list.innerHTML = '<li class="hint" style="background:transparent;border:none;padding:4px 0;">暂无其他卡片引用本卡</li>';
      return;
    }

    backlinks.forEach(function (bl) {
      var li = document.createElement("li");
      var left = document.createElement("div");

      var titleSpan = document.createElement("span");
      titleSpan.className = "link-title";
      titleSpan.textContent = getCardDisplayTitle(bl.sourceCardId);
      titleSpan.addEventListener("click", function () {
        openCard(bl.sourceCardId, "notes", "preview", true);
      });

      var typeBadge = document.createElement("span");
      typeBadge.className = "ref-type-tag";
      typeBadge.textContent = bl.type;

      left.appendChild(titleSpan);
      left.appendChild(typeBadge);
      li.appendChild(left);
      list.appendChild(li);
    });
  }

  // ==================== ③ 成稿面：富文本与纯文本字数统计 ====================
  function updateDraftCharCount() {
    var draftEditor = document.getElementById("draft-editor");
    var plainText = stripHtml(draftEditor.innerHTML);
    document.getElementById("draft-char-count").textContent = plainText.length;
  }

  // ==================== 回收站逻辑 ====================
  function openTrashModal() {
    var trashed = getTrashedCards();
    var list = document.getElementById("trash-list");
    list.innerHTML = "";

    if (trashed.length === 0) {
      list.innerHTML = '<div class="hint" style="padding:20px;text-align:center;">回收站为空</div>';
    } else {
      trashed.forEach(function (card) {
        var item = document.createElement("div");
        item.className = "trash-item";
        var rawTitle = (card.prompt || "").trim() || "（未命名题目）";
        item.innerHTML =
          '<div>' +
            '<strong>' + escapeHtml(rawTitle.slice(0, 60)) + '</strong>' +
            '<div class="hint">删除于：' + formatTime(card.deletedAt) + '</div>' +
          '</div>' +
          '<div style="display:flex;gap:8px;">' +
            '<button class="btn-secondary btn-sm restore-btn">恢复</button>' +
            '<button class="btn-danger btn-sm perm-del-btn">彻底删除</button>' +
          '</div>';

        item.querySelector(".restore-btn").addEventListener("click", function () {
          card.deletedAt = null;
          saveCardToDB(card, false).then(function () {
            openTrashModal();
            renderWall();
          });
        });

        item.querySelector(".perm-del-btn").addEventListener("click", function () {
          var brokenCount = countBrokenReferencesIfDeleted([card.id]);
          var msg = "确定彻底删除此卡片吗？此操作不可恢复。";
          if (brokenCount > 0) {
            msg += "\n注意：这将在其他卡片中留下 " + brokenCount + " 处「卡片已删除」占位引用（不会改写你的正文）。";
          }
          if (!confirm(msg)) return;
          deleteCardPermanentlyFromDB(card.id).then(function () {
            openTrashModal();
            renderWall();
          });
        });

        list.appendChild(item);
      });
    }

    document.getElementById("trash-modal").classList.remove("hidden");
  }

  function countBrokenReferencesIfDeleted(targetIds) {
    var targetSet = {};
    targetIds.forEach(function (id) { targetSet[id] = true; });
    var count = 0;

    getActiveCards().forEach(function (card) {
      var refs = extractForwardRefsFromCard(card);
      refs.forEach(function (r) {
        if (targetSet[r.targetCardId]) count++;
      });
    });
    return count;
  }

  // ==================== 存储导出与按 ID 合并导入 ====================
  function exportAllToJson() {
    var allCards = Object.keys(cardsMap).map(function (id) { return cardsMap[id]; });
    var payload = {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      cardCount: allCards.length,
      cards: allCards
    };

    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    var dateStr = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = "essay-card-box-backup-" + dateStr + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function isCardContentEqual(a, b) {
    return a.prompt === b.prompt &&
      a.notesMd === b.notesMd &&
      a.draftHtml === b.draftHtml &&
      (a.deletedAt || null) === (b.deletedAt || null) &&
      JSON.stringify(a.tags || []) === JSON.stringify(b.tags || []) &&
      JSON.stringify(a.relatedCardIds || []) === JSON.stringify(b.relatedCardIds || []) &&
      JSON.stringify(a.blockBindings || []) === JSON.stringify(b.blockBindings || []);
  }

  function handleImportFileSelected(e) {
    var file = e.target.files[0];
    if (!file) return;
    e.target.value = "";

    var reader = new FileReader();
    reader.onload = function (ev) {
      try {
        var parsed = JSON.parse(ev.target.result);
        if (!parsed || !Array.isArray(parsed.cards)) {
          alert("无效的备份文件：缺少 cards 数组。");
          return;
        }
        prepareImportPlan(parsed);
      } catch (err) {
        alert("JSON 解析失败：" + err.message);
      }
    };
    reader.readAsText(file, "utf-8");
  }

  function prepareImportPlan(parsedData) {
    var incomingCards = parsedData.cards.map(normalizeCard);
    var toAdd = [];
    var conflicts = [];
    var unchangedCount = 0;
    var incomingDeletedCount = 0;

    incomingCards.forEach(function (inc) {
      if (!inc.id) return;
      if (inc.deletedAt) incomingDeletedCount++;
      var local = cardsMap[inc.id];
      if (!local) {
        toAdd.push(inc);
      } else if (isCardContentEqual(local, inc)) {
        unchangedCount++;
      } else {
        conflicts.push({
          id: inc.id,
          local: local,
          incoming: inc,
          resolution: inc.updatedAt >= local.updatedAt ? "incoming" : "local"
        });
      }
    });

    pendingImportPlan = {
      schemaVersion: parsedData.schemaVersion || 1,
      toAdd: toAdd,
      conflicts: conflicts,
      unchangedCount: unchangedCount
    };

    // 渲染差异概览与逐条冲突选择器
    var summaryEl = document.getElementById("import-summary");
    summaryEl.innerHTML =
      "<div><strong>备份 Schema 版本：</strong>v" + pendingImportPlan.schemaVersion + "</div>" +
      "<div style='margin-top:6px;'>差异概览：新增卡片 <b>" + toAdd.length + "</b> 张 · " +
      "内容冲突 <b>" + conflicts.length + "</b> 张 · " +
      "完全一致跳过 <b>" + unchangedCount + "</b> 张 · " +
      "含回收站状态卡片 <b>" + incomingDeletedCount + "</b> 张</div>";

    var conflictsContainer = document.getElementById("import-conflicts-container");
    conflictsContainer.innerHTML = "";

    if (conflicts.length === 0) {
      conflictsContainer.innerHTML = '<div class="hint">无内容冲突，点击「确认执行合并」即可安全并入。</div>';
    } else {
      conflicts.forEach(function (item, idx) {
        var div = document.createElement("div");
        div.className = "conflict-item";
        var title = (item.incoming.prompt || item.local.prompt || "（未命名题目）").slice(0, 45);
        div.innerHTML =
          '<div>' +
            '<strong>' + escapeHtml(title) + '</strong> <span class="card-item-id">#' + shortId(item.id) + '</span>' +
            '<div class="hint">本地更新：' + formatTime(item.local.updatedAt) + (item.local.deletedAt ? " [回收站]" : "") +
            ' ｜ 导入更新：' + formatTime(item.incoming.updatedAt) + (item.incoming.deletedAt ? " [回收站]" : "") + '</div>' +
          '</div>' +
          '<div>' +
            '<select data-conflict-idx="' + idx + '" style="padding:5px 8px;border-radius:4px;border:1px solid #cbd5e1;">' +
              '<option value="local"' + (item.resolution === "local" ? " selected" : "") + '>保留本地</option>' +
              '<option value="incoming"' + (item.resolution === "incoming" ? " selected" : "") + '>使用导入</option>' +
            '</select>' +
          '</div>';

        div.querySelector("select").addEventListener("change", function (ev) {
          conflicts[idx].resolution = ev.target.value;
        });
        conflictsContainer.appendChild(div);
      });
    }

    document.getElementById("import-modal").classList.remove("hidden");
  }

  function executeImportMerge() {
    if (!pendingImportPlan) return;
    var promises = [];

    pendingImportPlan.toAdd.forEach(function (c) {
      promises.push(saveCardToDB(c, false));
    });

    pendingImportPlan.conflicts.forEach(function (item) {
      if (item.resolution === "incoming") {
        promises.push(saveCardToDB(item.incoming, false));
      }
    });

    Promise.all(promises).then(function () {
      pendingImportPlan = null;
      document.getElementById("import-modal").classList.add("hidden");
      if (currentViewState.cardId) {
        renderCardWorkspace();
      } else {
        renderWall();
      }
      alert("导入合并完成！");
    });
  }

  // ==================== 事件绑定初始化 ====================
  function bindEvents() {
    // 卡片墙搜索与标签模式
    var searchInput = document.getElementById("search-input");
    var clearSearchBtn = document.getElementById("clear-search-btn");

    searchInput.addEventListener("input", function () {
      wallState.searchQuery = searchInput.value;
      clearSearchBtn.classList.toggle("hidden", !wallState.searchQuery);
      renderWall();
    });

    clearSearchBtn.addEventListener("click", function () {
      searchInput.value = "";
      wallState.searchQuery = "";
      clearSearchBtn.classList.add("hidden");
      renderWall();
    });

    document.getElementById("tag-mode-btn").addEventListener("click", function (e) {
      wallState.tagMode = wallState.tagMode === "AND" ? "OR" : "AND";
      e.target.textContent = wallState.tagMode === "AND"
        ? "模式：同时满足 (AND)"
        : "模式：命中任一 (OR)";
      renderWall();
    });

    // 新建卡片
    document.getElementById("new-card-btn").addEventListener("click", function () {
      var newCard = normalizeCard({
        id: generateId(),
        prompt: "",
        notesMd: "",
        draftHtml: "",
        tags: [],
        relatedCardIds: [],
        blockBindings: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        deletedAt: null
      });
      saveCardToDB(newCard).then(function () {
        openCard(newCard.id, "prompt", "edit", true);
        document.getElementById("prompt-editor").focus();
      });
    });

    // 导入 / 导出 / 回收站
    document.getElementById("export-btn").addEventListener("click", exportAllToJson);
    document.getElementById("import-btn").addEventListener("click", function () {
      document.getElementById("import-file-input").click();
    });
    document.getElementById("import-file-input").addEventListener("change", handleImportFileSelected);
    document.getElementById("confirm-import-btn").addEventListener("click", executeImportMerge);

    document.getElementById("trash-btn").addEventListener("click", openTrashModal);
    document.getElementById("empty-trash-btn").addEventListener("click", function () {
      var trashed = getTrashedCards();
      if (trashed.length === 0) return;
      var ids = trashed.map(function (c) { return c.id; });
      var brokenCount = countBrokenReferencesIfDeleted(ids);
      var msg = "确定清空回收站（共 " + trashed.length + " 张卡片）吗？此操作不可撤销。";
      if (brokenCount > 0) {
        msg += "\n影响提示：清空后将在现有卡片中留下 " + brokenCount + " 处失效引用（显示为「卡片已删除」）。";
      }
      if (!confirm(msg)) return;
      Promise.all(ids.map(deleteCardPermanentlyFromDB)).then(function () {
        openTrashModal();
        renderWall();
      });
    });

    // 翻卡页顶部导航
    document.getElementById("back-wall-btn").addEventListener("click", switchToWallView);
    document.getElementById("back-history-btn").addEventListener("click", goBackInCardHistory);

    // 浏览器后退事件支持
    window.addEventListener("popstate", function () {
      if (navIndex > 0) {
        goBackInCardHistory();
      } else if (currentViewState.cardId) {
        switchToWallView();
      }
    });

    // 三面切换
    document.querySelectorAll(".face-tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        switchFace(tab.getAttribute("data-face"));
      });
    });

    // 删除卡片（移入回收站）
    document.getElementById("delete-card-btn").addEventListener("click", function () {
      var card = cardsMap[currentViewState.cardId];
      if (!card) return;
      card.deletedAt = Date.now();
      saveCardToDB(card, false).then(function () {
        switchToWallView();
      });
    });

    // 添加卡片标签
    document.getElementById("new-tag-input").addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        var val = e.target.value.trim();
        var card = cardsMap[currentViewState.cardId];
        if (val && card) {
          if (card.tags.indexOf(val) === -1) {
            card.tags.push(val);
            saveCardToDB(card);
            renderCardTags(card);
          }
          e.target.value = "";
        }
      }
    });

    // ① 问题面实时保存
    document.getElementById("prompt-editor").addEventListener("input", function (e) {
      var card = cardsMap[currentViewState.cardId];
      if (!card) return;
      card.prompt = e.target.value;
      saveCardToDB(card);
    });

    // ② 笔记面编辑/预览切换与输入
    document.getElementById("notes-edit-mode-btn").addEventListener("click", function () {
      currentViewState.notesMode = "edit";
      if (navIndex >= 0 && navHistory[navIndex]) navHistory[navIndex].notesMode = "edit";
      renderNotesFace(cardsMap[currentViewState.cardId]);
    });

    document.getElementById("notes-preview-mode-btn").addEventListener("click", function () {
      currentViewState.notesMode = "preview";
      if (navIndex >= 0 && navHistory[navIndex]) navHistory[navIndex].notesMode = "preview";
      hideAutocomplete();
      renderNotesFace(cardsMap[currentViewState.cardId]);
    });

    var notesEditor = document.getElementById("notes-editor");
    notesEditor.addEventListener("input", handleNotesEditorInput);
    notesEditor.addEventListener("keydown", function (e) {
      if (!acState.visible) return;
      if (e.key === "Escape") {
        hideAutocomplete();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        acState.selectedIndex = (acState.selectedIndex + 1) % Math.max(1, acState.candidates.length);
        updateAutocompleteHighlight();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        acState.selectedIndex = (acState.selectedIndex - 1 + acState.candidates.length) % Math.max(1, acState.candidates.length);
        updateAutocompleteHighlight();
      } else if (e.key === "Enter" && acState.candidates.length > 0) {
        e.preventDefault();
        insertAutocompleteCard(acState.candidates[acState.selectedIndex].id);
      }
    });

    // 手动添加底部相关卡片
    document.getElementById("add-related-btn").addEventListener("click", function () {
      var select = document.getElementById("related-card-select");
      var targetId = select.value;
      var card = cardsMap[currentViewState.cardId];
      if (targetId && card && card.relatedCardIds.indexOf(targetId) === -1) {
        card.relatedCardIds.push(targetId);
        saveCardToDB(card);
        renderRelatedCardsSection(card);
      }
    });

    // 块绑定模态框保存与解绑
    document.getElementById("save-block-bind-btn").addEventListener("click", function () {
      var card = cardsMap[currentViewState.cardId];
      var select = document.getElementById("block-target-select");
      var targetId = select.value;
      if (!card || !editingBlockId) return;

      card.blockBindings = (card.blockBindings || []).filter(function (b) {
        return b.blockId !== editingBlockId;
      });

      if (targetId) {
        card.blockBindings.push({
          blockId: editingBlockId,
          targetCardId: targetId,
          textHash: select.dataset.textHash || "",
          textSnapshot: select.dataset.textSnapshot || ""
        });
      }

      saveCardToDB(card);
      document.getElementById("block-bind-modal").classList.add("hidden");
      renderNotesPreviewBlocks(card);
    });

    document.getElementById("unbind-block-btn").addEventListener("click", function () {
      var card = cardsMap[currentViewState.cardId];
      if (!card || !editingBlockId) return;
      card.blockBindings = (card.blockBindings || []).filter(function (b) {
        return b.blockId !== editingBlockId;
      });
      saveCardToDB(card);
      document.getElementById("block-bind-modal").classList.add("hidden");
      renderNotesPreviewBlocks(card);
    });

    // ③ 成稿面富文本工具栏与实时保存
    document.querySelectorAll("#rich-toolbar button[data-cmd]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        document.execCommand(btn.getAttribute("data-cmd"), false, null);
        document.getElementById("draft-editor").focus();
      });
    });

    document.getElementById("rt-font-size").addEventListener("change", function (e) {
      document.execCommand("fontSize", false, e.target.value);
      document.getElementById("draft-editor").focus();
    });

    document.getElementById("rt-color").addEventListener("input", function (e) {
      document.execCommand("foreColor", false, e.target.value);
    });

    document.getElementById("draft-editor").addEventListener("input", function (e) {
      var card = cardsMap[currentViewState.cardId];
      if (!card) return;
      card.draftHtml = e.target.innerHTML;
      updateDraftCharCount();
      saveCardToDB(card);
    });

    // 通用关闭模态框按钮
    document.querySelectorAll(".close-modal-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var targetId = btn.getAttribute("data-target");
        document.getElementById(targetId).classList.add("hidden");
      });
    });
  }

  function updateAutocompleteHighlight() {
    var items = document.querySelectorAll("#autocomplete-popup .ac-item");
    items.forEach(function (el, idx) {
      el.classList.toggle("active", idx === acState.selectedIndex);
    });
  }

  // ==================== 启动入口 ====================
  initDB()
    .then(loadAllCardsFromDB)
    .then(function () {
      bindEvents();
      renderWall();
    })
    .catch(function (err) {
      alert("本地数据库初始化失败，请检查浏览器是否禁用了 IndexedDB：" + err);
    });
})();