# Azure Cosmos DB -- Social Posts: March 2026

**Report:** [2026-03-content.md](../reports/2026-03-content.md)
**Posting calendar:** [2026-03-posting-calendar.md](2026-03-posting-calendar.md)
**Platforms:** LinkedIn, X

---

## #1 — Priority-based throttling for NoSQL (Announcement)

**Report entry:** [#1 — Azure Cosmos DB adds priority-based throttling for NoSQL](../reports/2026-03-content.md#official-announcements--updates)
**Source:** https://azure.microsoft.com/updates/cosmos-db-priority-throttling

### LinkedIn — Option A (What changed)

```text
Azure Cosmos DB now supports priority-based throttling for NoSQL workloads.

This means you can mark certain operations as high-priority so they get RU allocation first when your database is under pressure. Low-priority background jobs (analytics queries, batch imports) yield to real-time user traffic automatically.

No code changes to your hot path. You set priority at the request level via the SDK, and Cosmos DB handles the rest.

Useful for workloads where you run mixed traffic on a shared container -- online transactions alongside offline processing -- without over-provisioning RUs.

Details: https://azure.microsoft.com/updates/cosmos-db-priority-throttling

#CosmosDB #Azure
```

### LinkedIn — Option B (What problem this solves)

```text
If you've ever had a batch import job starve your production reads, priority-based throttling in Azure Cosmos DB is worth knowing about.

You tag requests with a priority level (high or low). When the container hits its RU limit, low-priority requests get throttled first. High-priority requests keep flowing.

The practical impact: you can run analytics and bulk writes on the same container as your user-facing queries, without the risk of noisy-neighbor throttling.

Available now for NoSQL API. SDK support in .NET, Java, Python, and Node.js.

https://azure.microsoft.com/updates/cosmos-db-priority-throttling

#CosmosDB
```

### LinkedIn — Option C (Link in first comment)

**Post body:**

```text
Azure Cosmos DB added priority-based throttling for NoSQL.

Tag requests as high or low priority. When RU limits are hit, low-priority requests yield first. Your production reads stay fast while background jobs wait their turn.

Simple concept, meaningful impact for mixed workloads.

#CosmosDB
```

**First comment:**

```text
https://azure.microsoft.com/updates/cosmos-db-priority-throttling
```

**Thumbnail:**

![Priority-Based Throttling — Azure Cosmos DB for NoSQL](images/2026-03/1-linkedin-priority-throttling.png)

| Property | Value |
|----------|-------|
| Platform | LinkedIn (1200x627) |
| Background | Dark (#1a1a2e) |
| Logo | Cosmos DB logo (top-left) |
| Headline | "Priority-Based Throttling" |
| Subtext | "Azure Cosmos DB for NoSQL" |
| Accent | #0078D4 |
| Save path | `social-posts/images/2026-03/1-linkedin-priority-throttling.png` |

### X — Option A

```text
Azure Cosmos DB now has priority-based throttling for NoSQL.

Tag requests high or low priority. Under RU pressure, low-priority gets throttled first. Production reads stay fast.

Useful for mixed workloads on shared containers.

https://azure.microsoft.com/updates/cosmos-db-priority-throttling

#CosmosDB
```

### X — Option B

```text
New in Azure Cosmos DB: priority-based request throttling.

Your batch imports and analytics queries automatically yield to production traffic when RUs are constrained. No code changes to your hot path.

https://azure.microsoft.com/updates/cosmos-db-priority-throttling
```

### X — Option C

```text
If you run production reads and batch jobs on the same Cosmos DB container, priority-based throttling lets you protect the reads.

Tag requests with priority levels. Low-priority operations throttle first under load.

https://azure.microsoft.com/updates/cosmos-db-priority-throttling #CosmosDB
```

---

## #3 — RAG pipeline with Cosmos DB and Semantic Kernel (Blog Post)

**Report entry:** [#3 — Building a RAG pipeline with Azure Cosmos DB and Semantic Kernel](../reports/2026-03-content.md#blog-posts--articles)
**Source:** https://dev.to/justinepark/rag-pipeline-cosmos-db-semantic-kernel

### LinkedIn — Option A (Here's what you can build)

```text
Justine Park walks through building a full RAG pipeline using Azure Cosmos DB and Semantic Kernel.

The setup: documents stored in Cosmos DB with vector embeddings, Semantic Kernel for orchestration, and Azure OpenAI for generation. The post covers the indexing pipeline, the retrieval query (using Cosmos DB's integrated vector search), and how Semantic Kernel ties it together.

What makes it practical: the whole pipeline runs on a single Cosmos DB container -- no separate vector database. The post includes working code and performance numbers at ~10K documents.

https://dev.to/justinepark/rag-pipeline-cosmos-db-semantic-kernel

#CosmosDB #SemanticKernel
```

### LinkedIn — Option B (Here's how this works)

```text
Building RAG with Azure Cosmos DB means you don't need a separate vector store.

Justine Park's walkthrough shows how to:
- Store documents and vector embeddings in the same Cosmos DB container
- Use integrated vector search for retrieval
- Wire it all up through Semantic Kernel

The result is a simpler architecture with fewer moving parts. One database for your operational data and your vector index.

Full tutorial with code: https://dev.to/justinepark/rag-pipeline-cosmos-db-semantic-kernel

#CosmosDB
```

### LinkedIn — Option C (Link in first comment)

**Post body:**

```text
Building RAG doesn't require a separate vector store if you're already using Azure Cosmos DB.

Justine Park shows how to store documents and embeddings in one container, use integrated vector search for retrieval, and orchestrate with Semantic Kernel.

One database for operational data and vector search. Simpler architecture.

#CosmosDB
```

**First comment:**

```text
Full tutorial with working code: https://dev.to/justinepark/rag-pipeline-cosmos-db-semantic-kernel
```

**Thumbnail:**

![RAG Pipeline with Azure Cosmos DB and Semantic Kernel](images/2026-03/3-linkedin-rag-semantic-kernel.png)

| Property | Value |
|----------|-------|
| Platform | LinkedIn (1200x627) |
| Background | Dark (#1a1a2e) |
| Logo | Cosmos DB logo (top-left) |
| Headline | "RAG with Cosmos DB" |
| Subtext | "Semantic Kernel + Vector Search" |
| Accent | #0078D4 |
| Save path | `social-posts/images/2026-03/3-linkedin-rag-semantic-kernel.png` |

### X — Option A

```text
RAG with Azure Cosmos DB + Semantic Kernel -- no separate vector database needed.

Store documents, embeddings, and operational data in one container. Use integrated vector search for retrieval.

Full walkthrough with code by @justinepark:

https://dev.to/justinepark/rag-pipeline-cosmos-db-semantic-kernel
```

### X — Option B

```text
Practical RAG tutorial: Azure Cosmos DB for storage + vector search, Semantic Kernel for orchestration, Azure OpenAI for generation.

One database, no separate vector store.

https://dev.to/justinepark/rag-pipeline-cosmos-db-semantic-kernel #CosmosDB
```

### X — Option C

```text
If you're building RAG apps and want to skip the second database for vectors, this walkthrough shows how Azure Cosmos DB handles both.

Working code + performance numbers at 10K docs.

https://dev.to/justinepark/rag-pipeline-cosmos-db-semantic-kernel
```

---

*(...additional items #2, #4-#18 follow the same pattern — each with report back-link, source URL, separate code blocks for "link in first comment" body and comment, and inline thumbnail images...)*

---

## Generation Notes
- 18 content items processed
- Posts generated for: LinkedIn, X
- Each "link in first comment" option has separate copy blocks for post body and comment
- Thumbnail images rendered inline with markdown image references
- All items link back to their report entry
- All posts follow Microsoft Social Media Standards for Developer Accounts
