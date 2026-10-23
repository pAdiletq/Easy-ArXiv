// Handpicked starting points and a prepared learning demo, not live search or AI output.
// Metadata checked against each paper's primary arXiv record on 20 October 2026.
// Summaries, learning notes, and questions are original editorial paraphrases.
(function () {
    'use strict';

    const featured = [
        {
            id: '1706.03762',
            title: 'Attention Is All You Need',
            authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar', 'Jakob Uszkoreit', 'Llion Jones', 'Aidan N. Gomez', 'Lukasz Kaiser', 'Illia Polosukhin'],
            published: '2017-06-12T17:57:34Z',
            pdf_url: 'https://arxiv.org/pdf/1706.03762',
            link: 'https://arxiv.org/abs/1706.03762',
            summary: 'This paper introduces the Transformer for sequence-to-sequence tasks such as translation. Instead of processing tokens through recurrent or convolutional layers, it uses attention to connect information across a sequence. The authors compare translation quality and training costs with earlier systems, and also test English constituency parsing. It is a useful starting point for understanding the architecture behind many later language models, rather than a guide to training a modern chatbot.',
            keywords: ['Transformers', 'Attention', 'Machine translation'],
            category: 'cs.CL',
            source_label: 'Handpicked paper',
            summary_label: 'Editorial overview'
        },
        {
            id: '2006.11239',
            title: 'Denoising Diffusion Probabilistic Models',
            authors: ['Jonathan Ho', 'Ajay Jain', 'Pieter Abbeel'],
            published: '2020-06-19T17:24:44Z',
            pdf_url: 'https://arxiv.org/pdf/2006.11239',
            link: 'https://arxiv.org/abs/2006.11239',
            summary: 'Diffusion models learn to generate images by reversing a process that gradually adds noise to data. This paper develops a practical training approach and connects diffusion probabilistic models with denoising score matching. Experiments on image benchmarks show that the method can produce detailed samples. Read it to understand the central denoising idea and the training objective; the paper studies image generation, not the text-to-image prompting interfaces that became common later.',
            keywords: ['Diffusion models', 'Image generation', 'Denoising'],
            category: 'cs.LG',
            source_label: 'Handpicked paper',
            summary_label: 'Editorial overview'
        },
        {
            id: '2106.09685',
            title: 'LoRA: Low-Rank Adaptation of Large Language Models',
            authors: ['Edward J. Hu', 'Yelong Shen', 'Phillip Wallis', 'Zeyuan Allen-Zhu', 'Yuanzhi Li', 'Shean Wang', 'Lu Wang', 'Weizhu Chen'],
            published: '2021-06-17T17:37:18Z',
            pdf_url: 'https://arxiv.org/pdf/2106.09685',
            link: 'https://arxiv.org/abs/2106.09685',
            summary: 'Adapting a large pretrained model can be expensive when every parameter must change. LoRA keeps the original weights fixed and learns smaller, low-rank updates instead. The authors evaluate this approach across several language models and tasks, comparing model quality, trainable parameters, and memory use with full fine-tuning. This paper is a practical entry point into parameter-efficient adaptation and explains why a compact task-specific update can replace a separately fine-tuned model copy.',
            keywords: ['LoRA', 'Fine-tuning', 'Language models'],
            category: 'cs.CL',
            source_label: 'Handpicked paper',
            summary_label: 'Editorial overview'
        }
    ];

    const attentionQuest = {
        title: 'Attention Is All You Need',
        pdf: 'https://arxiv.org/pdf/1706.03762',
        source_url: 'https://arxiv.org/html/1706.03762v7',
        demo: true,
        label: 'Prepared learning demo',
        description: 'A prepared example based on the paper. New AI analysis runs only when you request it.',
        flashcards: {
            flashcards: [
                { 'The core change': 'The Transformer replaces recurrent and convolutional sequence processing with attention, enabling more parallel training.' },
                { 'Encoder and decoder': 'The encoder represents input tokens; the decoder uses those representations to generate output tokens.' },
                { 'Queries, keys, values': 'Attention matches queries against keys, then combines the associated values using the resulting weights.' },
                { 'Scaling attention': 'Dividing attention scores by the square root of key size helps avoid overly saturated softmax outputs.' },
                { 'Multiple heads': 'Separate learned projections let attention heads capture different relationships before their outputs are combined.' },
                { 'Token order': 'Positional encodings add order information to embeddings because attention alone does not encode sequence position.' },
                { 'Causal masking': 'The decoder masks future output positions so predictions cannot use tokens unavailable during generation.' },
                { 'Beyond attention': 'Each layer also includes a position-wise feed-forward network, residual connections, and layer normalization.' },
                { 'Training versus generation': 'Training can process known target positions together; generation still produces output tokens one at a time.' }
            ]
        },
        questions: {
            questions: [
                {
                    question: 'What replaces sequence-aligned recurrence?',
                    options: ['Attention', 'Convolution only', 'Nearest neighbors', 'Decision trees'],
                    answer: 0,
                    explanation: 'Attention connects positions without recurrent sequence processing.'
                },
                {
                    question: 'What does encoder-decoder attention access?',
                    options: ['Future outputs', 'Training labels only', 'Encoder representations', 'Random images'],
                    answer: 2,
                    explanation: 'Decoder queries attend to encoder keys and values.'
                },
                {
                    question: 'What does attention combine?',
                    options: ['Only positions', 'Weighted values', 'Only queries', 'Vocabulary counts'],
                    answer: 1,
                    explanation: 'Query-key compatibility determines weights on values.'
                },
                {
                    question: 'Why scale dot-product scores?',
                    options: ['Remove order', 'Delete heads', 'Replace embeddings', 'Limit softmax saturation'],
                    answer: 3,
                    explanation: 'Large scores can produce very small softmax gradients.'
                },
                {
                    question: 'Why use multiple attention heads?',
                    options: ['Capture different relationships', 'Eliminate training', 'Hide tokens', 'Remove projections'],
                    answer: 0,
                    explanation: 'Heads operate in different learned representation subspaces.'
                },
                {
                    question: 'What supplies token-order information?',
                    options: ['Batch size', 'Dropout alone', 'Positional encodings', 'Output vocabulary'],
                    answer: 2,
                    explanation: 'Positional signals are added to token embeddings.'
                },
                {
                    question: 'What does decoder masking block?',
                    options: ['All inputs', 'Future outputs', 'Current embeddings', 'Earlier outputs'],
                    answer: 1,
                    explanation: 'Future target tokens must not influence current predictions.'
                },
                {
                    question: 'What accompanies attention in each layer?',
                    options: ['A database', 'Image cropping', 'A recurrent loop', 'Feed-forward processing'],
                    answer: 3,
                    explanation: 'Position-wise networks transform each token representation.'
                },
                {
                    question: 'How does the original decoder generate?',
                    options: ['One token at a time', 'Every token independently', 'One image per head', 'Without prior outputs'],
                    answer: 0,
                    explanation: 'Generation is autoregressive, even though training is parallelizable.'
                }
            ]
        }
    };

    window.EasyArxivPapers = { featured, attentionQuest };
}());
