package com.bluegrain.smsrelay

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import org.commonmark.node.*
import org.commonmark.parser.Parser

private fun Node.children(): List<Node> = buildList {
    var child = firstChild
    while (child != null) { add(child); child = child.next }
}

/** Native text only: no HTML execution, WebView, image requests or active URLs. */
private fun inline(node: Node): AnnotatedString = buildAnnotatedString {
    fun AnnotatedString.Builder.walk(n: Node, depth: Int = 0) {
        if (depth > 32) { append("…"); return }
        when (n) {
            is org.commonmark.node.Text -> append(n.literal)
            is Code -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(n.literal) }
            is StrongEmphasis -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { n.children().forEach { walk(it, depth + 1) } }
            is Emphasis -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { n.children().forEach { walk(it, depth + 1) } }
            is SoftLineBreak -> append(" ")
            is HardLineBreak -> append("\n")
            is HtmlInline -> append(n.literal)
            else -> n.children().forEach { walk(it, depth + 1) }
        }
    }
    walk(node)
}

@Composable
fun MarkdownMessage(markdown: String) {
    val document = remember(markdown) { Parser.builder().build().parse(markdown) }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        document.children().forEach { MarkdownBlock(it) }
    }
}

@Composable
private fun MarkdownBlock(node: Node, depth: Int = 0) {
    // Bound visual indentation for adversarially nested caller-supplied text.
    if (depth > 8) { Text(inline(node), style = MaterialTheme.typography.bodyMedium); return }
    when (node) {
        is Heading -> Text(inline(node), style = if (node.level <= 2) MaterialTheme.typography.titleLarge else MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold)
        is Paragraph -> Text(inline(node), style = MaterialTheme.typography.bodyLarge)
        is BulletList, is OrderedList -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            node.children().forEachIndexed { index, item ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(if (node is OrderedList) "${node.markerStartNumber + index}." else "•")
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        item.children().forEach { MarkdownBlock(it, depth + 1) }
                    }
                }
            }
        }
        is BlockQuote -> Surface(color = MaterialTheme.colorScheme.surfaceVariant) {
            Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                node.children().forEach { MarkdownBlock(it, depth + 1) }
            }
        }
        is FencedCodeBlock, is IndentedCodeBlock -> {
            val literal = if (node is FencedCodeBlock) node.literal else (node as IndentedCodeBlock).literal
            Surface(color = MaterialTheme.colorScheme.surfaceVariant) {
                Text(literal.trimEnd(), Modifier.fillMaxWidth().padding(12.dp), fontFamily = FontFamily.Monospace,
                    style = MaterialTheme.typography.bodyMedium)
            }
        }
        is HtmlBlock -> Text(node.literal, style = MaterialTheme.typography.bodyMedium)
        is ThematicBreak -> HorizontalDivider()
        else -> Text(inline(node), style = MaterialTheme.typography.bodyLarge)
    }
}
