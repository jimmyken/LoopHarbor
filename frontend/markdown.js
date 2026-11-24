import markdownit from "markdown-it";
import texmath from "markdown-it-texmath";
import katex from "katex";
import DOMPurify from "dompurify";

const markdown = markdownit({ html: false, linkify: false, breaks: true })
  .use(texmath, {
    engine: katex,
    delimiters: ["dollars", "brackets"],
    katexOptions: { throwOnError: false, trust: false, maxExpand: 100 },
  });

markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer");
  return self.renderToken(tokens, index, options);
};

window.renderAgentMarkdown = (text) => DOMPurify.sanitize(markdown.render(text), {
  FORBID_TAGS: ["img", "iframe", "object", "embed", "style"],
});
